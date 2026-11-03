import { Server, type Tool } from "@modelcontextprotocol/server";
import { FileSystemService } from "./filesystem.js";
import { FrontmatterHandler, parseFrontmatter } from "./frontmatter.js";
import { PathFilter } from "./pathfilter.js";
import { SearchService } from "./search.js";
import { handleWikiLinkTool } from "./wikilink/index.js";
import { posix, resolve } from "path";

export interface CreateServerOptions {
  name?: string;
  version?: string;
  pathFilter?: PathFilter;
  frontmatterHandler?: FrontmatterHandler;
  /** Expose read tools only and reject direct calls to mutating tools. */
  readOnly?: boolean;
  /** Vault-relative subtrees hidden from search and directory listings. */
  excludePaths?: string[];
  /** Maximum accepted upload_file size in bytes (default: 10 MiB). */
  maxUploadBytes?: number;
}

const MUTATING_TOOLS = new Set([
  "write_note",
  "patch_note",
  "delete_note",
  "move_note",
  "move_file",
  "update_frontmatter",
  "manage_tags",
  "upload_file",
]);

function normalizeSubtree(path: string): string {
  let relativePath = path.trim().replace(/\\/g, "/");
  while (relativePath.startsWith("/")) relativePath = relativePath.slice(1);

  const normalizedPath = posix.normalize(relativePath);
  if (normalizedPath === ".") return "";
  return normalizedPath.endsWith("/") ? normalizedPath.slice(0, -1) : normalizedPath;
}

function mergeExcludePaths(defaults: string[], requested: unknown): string[] {
  const provided = Array.isArray(requested) ? requested : [];
  return [...new Set([...defaults, ...provided]
    .filter((path): path is string => typeof path === "string")
    .map(normalizeSubtree)
    .filter(Boolean))];
}

function isExcluded(path: string, excludePaths: string[]): boolean {
  const normalizedPath = normalizeSubtree(path);
  return excludePaths.some((excluded) =>
    normalizedPath === excluded || normalizedPath.startsWith(`${excluded}/`)
  );
}

export function createServer(vaultPath: string, options: CreateServerOptions = {}): Server {
  const {
    name = "mcpvault",
    version = "0.0.0",
    pathFilter = new PathFilter(),
    frontmatterHandler = new FrontmatterHandler(),
    readOnly = false,
    excludePaths = [],
    maxUploadBytes,
  } = options;

  const defaultExcludePaths = mergeExcludePaths([], excludePaths);
  const resolvedVaultPath = resolve(vaultPath);
  const fileSystem = new FileSystemService(
    resolvedVaultPath,
    pathFilter,
    frontmatterHandler,
    maxUploadBytes !== undefined ? { maxUploadBytes } : {}
  );
  const searchService = new SearchService(resolvedVaultPath, pathFilter);

  const server = new Server({ name, version }, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler("tools/list", async () => {
    const tools: Tool[] = [
        {
          name: "read_note",
          description: "Read a note from the Obsidian vault",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the note relative to vault root" },
              prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
            },
            required: ["path"]
          }
        },
        {
          name: "write_note",
          description: "Write a note to the Obsidian vault",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the note relative to vault root" },
              content: { type: "string", description: "Content of the note" },
              frontmatter: { type: "object", description: "Frontmatter object (optional)" },
              mode: { type: "string", enum: ["overwrite", "append", "prepend"], description: "Write mode: 'overwrite' (default), 'append', or 'prepend'", default: "overwrite" }
            },
            required: ["path", "content"]
          }
        },
        {
          name: "patch_note",
          description: "Efficiently update part of a note by replacing a specific string. This is more efficient than rewriting the entire note for small changes.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the note relative to vault root" },
              oldString: { type: "string", description: "The exact string to replace. Must match exactly including whitespace and line breaks." },
              newString: { type: "string", description: "The new string to insert in place of oldString" },
              replaceAll: { type: "boolean", description: "If true, replace all occurrences. If false (default), the operation will fail if multiple matches are found to prevent unintended replacements.", default: false }
            },
            required: ["path", "oldString", "newString"]
          }
        },
        {
          name: "list_directory",
          description: "List files and directories in the vault (includes non-note filenames, while read/write tools remain note-only)",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path relative to vault root (default: '/')", default: "/" },
              prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
            }
          }
        },
        {
          name: "delete_note",
          description: "Delete a note from the Obsidian vault (requires confirmation). Supports permanent delete, vault trash, or system trash.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the note relative to vault root" },
              confirmPath: { type: "string", description: "Confirmation: must exactly match the path parameter to proceed with deletion" },
              trashMode: { type: "string", enum: ["none", "local", "system"], description: "Deletion mode: 'none' = permanent delete (default), 'local' = move to .trash inside vault, 'system' = move to OS trash", default: "none" }
            },
            required: ["path", "confirmPath"]
          }
        },
        {
          name: "search_notes",
          description: "Search for notes in the vault by content or frontmatter",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query text" },
              limit: { type: "number", description: "Maximum number of results (default: 5, max: 20)", default: 5 },
              searchContent: { type: "boolean", description: "Search in note content (default: true)", default: true },
              searchFrontmatter: { type: "boolean", description: "Search in frontmatter (default: false)", default: false },
              caseSensitive: { type: "boolean", description: "Case sensitive search (default: false)", default: false },
              pathPrefix: { type: "string", description: "Restrict the search to a vault subtree, e.g. \"Projects/2026\" (directory prefix)" },
              excludePaths: { type: "array", items: { type: "string" }, description: "Skip files under these subtrees, e.g. [\"Archive\", \"meta\"] (directory prefixes)" },
              prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
            },
            required: ["query"]
          }
        },
        {
          name: "move_note",
          description: "Move or rename a note in the vault",
          inputSchema: {
            type: "object",
            properties: {
              oldPath: { type: "string", description: "Current path of the note" },
              newPath: { type: "string", description: "New path for the note" },
              overwrite: { type: "boolean", description: "Allow overwriting existing file (default: false)", default: false }
            },
            required: ["oldPath", "newPath"]
          }
        },
        {
          name: "move_file",
          description: "Move or rename any file in the vault (binary-safe, file-only, requires confirmation)",
          inputSchema: {
            type: "object",
            properties: {
              oldPath: { type: "string", description: "Current path of the file" },
              newPath: { type: "string", description: "New path for the file" },
              confirmOldPath: { type: "string", description: "Confirmation: must exactly match oldPath" },
              confirmNewPath: { type: "string", description: "Confirmation: must exactly match newPath" },
              overwrite: { type: "boolean", description: "Allow overwriting existing file (default: false)", default: false }
            },
            required: ["oldPath", "newPath", "confirmOldPath", "confirmNewPath"]
          }
        },
        {
          name: "upload_file",
          description: "Upload a file (image, PDF, or any other attachment — any extension, including none) into the vault, from either base64-encoded content or a downloaded file reference (e.g. a ChatGPT-provided upload). Provide exactly one of contentBase64 or file. A bare file name (no folder, no leading '/') is placed in Obsidian's configured attachment folder; a path with a folder, or a leading '/', is used as given (vault root, explicitly, for a leading '/'). Existing files are never overwritten unless overwrite is true and confirmPath repeats path.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Target path for the uploaded file, relative to vault root. A bare file name goes to Obsidian's configured attachment folder; a leading '/' means vault root explicitly, bypassing that folder." },
              contentBase64: { type: "string", description: "Base64-encoded file content. Provide exactly one of contentBase64 or file." },
              file: {
                type: "object",
                description: "A file reference to download instead of inlining base64 (e.g. a ChatGPT connector upload). Provide exactly one of contentBase64 or file.",
                properties: {
                  download_url: { type: "string", description: "HTTPS URL to download the file content from" },
                  file_id: { type: "string", description: "Identifier for the uploaded file" },
                  mime_type: { type: "string", description: "MIME type of the file (optional)" },
                  file_name: { type: "string", description: "Original file name (optional)" }
                },
                required: ["download_url", "file_id"]
              },
              overwrite: { type: "boolean", description: "Allow overwriting an existing file (default: false). Requires confirmPath to repeat path.", default: false },
              confirmPath: { type: "string", description: "Confirmation required when overwrite is true: must exactly match path" }
            },
            required: ["path"]
          },
          _meta: { "openai/fileParams": ["file"] }
        },
        {
          name: "read_multiple_notes",
          description: "Read multiple notes in a batch (max 10 files)",
          inputSchema: {
            type: "object",
            properties: {
              paths: { type: "array", items: { type: "string" }, description: "Array of note paths to read", maxItems: 10 },
              includeContent: { type: "boolean", description: "Include note content (default: true)", default: true },
              includeFrontmatter: { type: "boolean", description: "Include frontmatter (default: true)", default: true },
              prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
            },
            required: ["paths"]
          }
        },
        {
          name: "update_frontmatter",
          description: "Update frontmatter of a note without changing content",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the note" },
              frontmatter: { type: "object", description: "Frontmatter object to update" },
              merge: { type: "boolean", description: "Merge with existing frontmatter (default: true)", default: true }
            },
            required: ["path", "frontmatter"]
          }
        },
        {
          name: "get_notes_info",
          description: "Get metadata for notes without reading full content",
          inputSchema: {
            type: "object",
            properties: {
              paths: { type: "array", items: { type: "string" }, description: "Array of note paths to get info for" },
              prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
            },
            required: ["paths"]
          }
        },
        {
          name: "get_frontmatter",
          description: "Extract frontmatter from a note without reading the content",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the note relative to vault root" },
              prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
            },
            required: ["path"]
          }
        },
        {
          name: "manage_tags",
          description: "Add, remove, or list tags in a note",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the note relative to vault root" },
              operation: { type: "string", enum: ["add", "remove", "list"], description: "Operation to perform: 'add', 'remove', or 'list'" },
              tags: { type: "array", items: { type: "string" }, description: "Array of tags (required for 'add' and 'remove' operations)" }
            },
            required: ["path", "operation"]
          }
        },
        {
          name: "get_vault_stats",
          description: "Get vault statistics including total notes, folders, size, and recently modified files. Useful for understanding vault scope before batch operations.",
          inputSchema: {
            type: "object",
            properties: {
              recentCount: { type: "number", description: "Number of recently modified files to return (default: 5, max: 20)", default: 5 },
              prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
            }
          }
        },
        {
          name: "list_all_tags",
          description: "List all tags across the vault with occurrence counts. Returns both frontmatter tags and inline #hashtags, deduplicated and sorted by frequency. Useful for discovering existing tags before creating or organizing notes.",
          inputSchema: {
            type: "object",
            properties: {
              prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
            }
          }
        },
        {
          name: "wiki_link",
          description: "Read an Obsidian wiki link. Accepts the same syntax as Obsidian: [[Document Name]] or [[Document Name|Display Text]], including table-authored escapes like [[Document Name\\|Display]] and path-qualified links like [[folder/Document Name]]. A #fragment suffix in the input is ignored. Searches the vault for an exact basename match (or exact vault-relative path match when the name contains '/') and returns the file's content. When multiple files share the basename, picks the first (vault root first, then alphabetical by path) and lists the other paths in structuredContent.alternatives. Content is returned bare — ready for direct use in context.",
          inputSchema: {
            type: "object",
            properties: {
              document: {
                type: "string",
                description: "The document name — what goes inside [[ ]]. e.g. 'My-Document'. Brackets and display text (|...) are stripped if present. The .md extension is always appended (never include it)."
              },
              prettyPrint: {
                type: "boolean",
                description: "Format JSON response with indentation (default: false)",
                default: false
              }
            },
            required: ["document"]
          }
        },
        {
          name: "get_note_outline",
          description: "Get the heading structure of a note without reading its full content. Returns headings with level, text, and line number. Use this first to navigate large notes efficiently, then call read_note_lines to read only the section you need.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the note relative to vault root" },
              prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
            },
            required: ["path"]
          }
        },
        {
          name: "read_note_lines",
          description: "Read a specific line range from a note. Use after get_note_outline to read only the section you need instead of the full file.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the note relative to vault root" },
              startLine: { type: "number", description: "First line to read (1-indexed, inclusive)" },
              endLine: { type: "number", description: "Last line to read (1-indexed, inclusive)" },
              prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
            },
            required: ["path", "startLine", "endLine"]
          }
        }
      ];

    return {
      tools: readOnly
        ? tools.filter((tool) => !MUTATING_TOOLS.has(tool.name))
        : tools,
    };
  });

  server.setRequestHandler("tools/call", async (request) => {
    const { name: toolName, arguments: args } = request.params;
    const trimmedArgs = trimPaths(args);

    if (readOnly && MUTATING_TOOLS.has(toolName)) {
      return {
        content: [{
          type: "text",
          text: `Error: ${toolName} is disabled because MCPVault is running in read-only mode. Restart without --read-only to enable vault mutations.`,
        }],
        isError: true,
      };
    }

    try {
      switch (toolName) {
        case "read_note": {
          const note = await fileSystem.readNote(trimmedArgs.path);
          const indent = trimmedArgs.prettyPrint ? 2 : undefined;
          return {
            content: [{ type: "text", text: JSON.stringify({ fm: note.frontmatter, content: note.content }, null, indent) }]
          };
        }

        case "write_note": {
          const fm = parseFrontmatter(trimmedArgs.frontmatter);
          await fileSystem.writeNote({
            path: trimmedArgs.path,
            content: trimmedArgs.content,
            ...(fm !== undefined && { frontmatter: fm }),
            mode: trimmedArgs.mode || 'overwrite'
          });
          return {
            content: [{ type: "text", text: `Successfully wrote note: ${trimmedArgs.path} (mode: ${trimmedArgs.mode || 'overwrite'})` }]
          };
        }

        case "patch_note": {
          const result = await fileSystem.patchNote({
            path: trimmedArgs.path,
            oldString: trimmedArgs.oldString,
            newString: trimmedArgs.newString,
            replaceAll: trimmedArgs.replaceAll
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: !result.success
          };
        }

        case "list_directory": {
          const requestedPath = normalizeSubtree(trimmedArgs.path || "");
          if (isExcluded(requestedPath, defaultExcludePaths)) {
            throw new Error(`Directory excluded by server configuration: ${requestedPath}`);
          }

          const listing = await fileSystem.listDirectory(trimmedArgs.path || "");
          const prefix = requestedPath ? `${requestedPath}/` : "";
          const directories = listing.directories.filter((name) =>
            !isExcluded(`${prefix}${name}`, defaultExcludePaths)
          );
          const files = listing.files.filter((name) =>
            !isExcluded(`${prefix}${name}`, defaultExcludePaths)
          );
          const indent = trimmedArgs.prettyPrint ? 2 : undefined;
          return {
            content: [{ type: "text", text: JSON.stringify({ dirs: directories, files }, null, indent) }]
          };
        }

        case "delete_note": {
          const result = await fileSystem.deleteNote({
            path: trimmedArgs.path,
            confirmPath: trimmedArgs.confirmPath,
            trashMode: trimmedArgs.trashMode
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: !result.success
          };
        }

        case "search_notes": {
          const results = await searchService.search({
            query: trimmedArgs.query,
            limit: trimmedArgs.limit,
            searchContent: trimmedArgs.searchContent,
            searchFrontmatter: trimmedArgs.searchFrontmatter,
            caseSensitive: trimmedArgs.caseSensitive,
            pathPrefix: trimmedArgs.pathPrefix,
            excludePaths: mergeExcludePaths(defaultExcludePaths, trimmedArgs.excludePaths)
          });
          const indent = trimmedArgs.prettyPrint ? 2 : undefined;
          return {
            content: [{ type: "text", text: JSON.stringify(results, null, indent) }]
          };
        }

        case "move_note": {
          const result = await fileSystem.moveNote({
            oldPath: trimmedArgs.oldPath,
            newPath: trimmedArgs.newPath,
            overwrite: trimmedArgs.overwrite
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: !result.success
          };
        }

        case "move_file": {
          const result = await fileSystem.moveFile({
            oldPath: trimmedArgs.oldPath,
            newPath: trimmedArgs.newPath,
            confirmOldPath: trimmedArgs.confirmOldPath,
            confirmNewPath: trimmedArgs.confirmNewPath,
            overwrite: trimmedArgs.overwrite
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: !result.success
          };
        }

        case "upload_file": {
          const result = await fileSystem.uploadFile({
            path: trimmedArgs.path,
            contentBase64: trimmedArgs.contentBase64,
            file: trimmedArgs.file,
            overwrite: trimmedArgs.overwrite,
            confirmPath: trimmedArgs.confirmPath
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: !result.success
          };
        }

        case "read_multiple_notes": {
          const result = await fileSystem.readMultipleNotes({
            paths: trimmedArgs.paths,
            includeContent: trimmedArgs.includeContent,
            includeFrontmatter: trimmedArgs.includeFrontmatter
          });
          const indent = trimmedArgs.prettyPrint ? 2 : undefined;
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: result.successful, err: result.failed }, null, indent) }]
          };
        }

        case "update_frontmatter": {
          const fm = parseFrontmatter(trimmedArgs.frontmatter);
          if (!fm) {
            throw new Error('frontmatter is required');
          }
          await fileSystem.updateFrontmatter({
            path: trimmedArgs.path,
            frontmatter: fm,
            merge: trimmedArgs.merge
          });
          return {
            content: [{ type: "text", text: `Successfully updated frontmatter for: ${trimmedArgs.path}` }]
          };
        }

        case "get_notes_info": {
          const result = await fileSystem.getNotesInfo(trimmedArgs.paths);
          const indent = trimmedArgs.prettyPrint ? 2 : undefined;
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, indent) }]
          };
        }

        case "get_frontmatter": {
          const note = await fileSystem.readNote(trimmedArgs.path);
          const indent = trimmedArgs.prettyPrint ? 2 : undefined;
          return {
            content: [{ type: "text", text: JSON.stringify(note.frontmatter, null, indent) }]
          };
        }

        case "manage_tags": {
          const result = await fileSystem.manageTags({
            path: trimmedArgs.path,
            operation: trimmedArgs.operation,
            tags: trimmedArgs.tags
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: !result.success
          };
        }

        case "get_vault_stats": {
          const recentCount = Math.min(trimmedArgs.recentCount || 5, 20);
          const stats = await fileSystem.getVaultStats(recentCount);
          const indent = trimmedArgs.prettyPrint ? 2 : undefined;
          return {
            content: [{ type: "text", text: JSON.stringify({ notes: stats.totalNotes, folders: stats.totalFolders, size: stats.totalSize, recent: stats.recentlyModified }, null, indent) }]
          };
        }

        case "list_all_tags": {
          const tags = await fileSystem.listAllTags();
          const indent = trimmedArgs.prettyPrint ? 2 : undefined;
          return {
            content: [{ type: "text", text: JSON.stringify(tags, null, indent) }]
          };
        }

        case "wiki_link":
          return await handleWikiLinkTool(fileSystem, trimmedArgs);

        case "get_note_outline": {
          const headings = await fileSystem.getNoteOutline(trimmedArgs.path);
          const indent = trimmedArgs.prettyPrint ? 2 : undefined;
          return {
            content: [{ type: "text", text: JSON.stringify(headings, null, indent) }]
          };
        }

        case "read_note_lines": {
          const text = await fileSystem.readNoteLines({
            path: trimmedArgs.path,
            startLine: trimmedArgs.startLine,
            endLine: trimmedArgs.endLine
          });
          return {
            content: [{ type: "text", text }]
          };
        }

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true
      };
    }
  });

  return server;
}

function trimPaths(args: any): any {
  const trimmed = { ...args };

  if (trimmed.path && typeof trimmed.path === 'string') trimmed.path = trimmed.path.trim();
  if (trimmed.oldPath && typeof trimmed.oldPath === 'string') trimmed.oldPath = trimmed.oldPath.trim();
  if (trimmed.newPath && typeof trimmed.newPath === 'string') trimmed.newPath = trimmed.newPath.trim();
  if (trimmed.confirmPath && typeof trimmed.confirmPath === 'string') trimmed.confirmPath = trimmed.confirmPath.trim();
  if (trimmed.confirmOldPath && typeof trimmed.confirmOldPath === 'string') trimmed.confirmOldPath = trimmed.confirmOldPath.trim();
  if (trimmed.confirmNewPath && typeof trimmed.confirmNewPath === 'string') trimmed.confirmNewPath = trimmed.confirmNewPath.trim();

  if (trimmed.paths && Array.isArray(trimmed.paths)) {
    trimmed.paths = trimmed.paths.map((p: any) => typeof p === 'string' ? p.trim() : p);
  }
  if (trimmed.excludePaths && Array.isArray(trimmed.excludePaths)) {
    trimmed.excludePaths = trimmed.excludePaths.map((p: any) => typeof p === 'string' ? p.trim() : p);
  }

  return trimmed;
}
