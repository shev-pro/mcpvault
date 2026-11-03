import { FrontmatterHandler } from './frontmatter.js';
import { PathFilter } from './pathfilter.js';
import type { ParsedNote, DirectoryListing, NoteWriteParams, DeleteNoteParams, DeleteResult, MoveNoteParams, MoveFileParams, MoveResult, BatchReadParams, BatchReadResult, UpdateFrontmatterParams, NoteInfo, TagManagementParams, TagManagementResult, PatchNoteParams, PatchNoteResult, VaultStats, NoteHeading, ReadNoteLinesParams, UploadFileParams, UploadResult, FileSystemServiceOptions } from './types.js';
/** Default cap on uploaded file size: 10 MiB. Overridable via FileSystemServiceOptions.maxUploadBytes. */
export declare const DEFAULT_MAX_UPLOAD_BYTES: number;
/**
 * Map a filesystem write failure to a clear, accurate Error.
 *
 * Classifies by the Node error `code`, NOT by message substring. The old
 * substring matching (`message.includes('space')`) mislabeled any error whose
 * message merely contained "space" as a disk-full error, producing false
 * "No space left on device" reports (#109). Errors we threw ourselves with a
 * meaningful message (no `code`) pass through unchanged.
 */
export declare function classifyWriteError(error: unknown, path: string): Error;
export declare class FileSystemService {
    private vaultPath;
    private frontmatterHandler;
    private pathFilter;
    private writeChains;
    private maxUploadBytes;
    private download;
    constructor(vaultPath: string, pathFilter?: PathFilter, frontmatterHandler?: FrontmatterHandler, options?: FileSystemServiceOptions);
    /**
     * Normalize an incoming path to be vault-relative. Strips leading slashes
     * and the vault path prefix when a caller accidentally passes an absolute path
     * (e.g. "/Users/me/vault/wiki/note.md" instead of "wiki/note.md").
     */
    private normalizePath;
    /**
     * `filterMode` picks which PathFilter check validates the *resolved*
     * target when `followSymlinks` is true: 'note' (isAllowed, extension
     * whitelist — the default, used by every note-only caller) or 'any'
     * (isAllowedForListing — no extension check, used by uploadFile and
     * moveFile's binary-safe paths) so non-note callers don't duplicate this
     * walk just to apply a different filter.
     */
    private resolvePath;
    private withPathLock;
    /** `content` is utf-8 encoded when a string; a Uint8Array is written verbatim (uploadFile's binary payloads). */
    private atomicWrite;
    /**
     * Create-only write for uploadFile's non-overwrite path (I2): write to a
     * temp file, fsync, then `link` it onto the target — `link` fails EEXIST
     * atomically if the target already exists (also racing other processes,
     * unlike a prior `stat`/`access` check), so this is the actual no-clobber
     * guarantee rather than the per-path lock (which only coordinates callers
     * within this one service instance, see AGENTS.md).
     */
    private createNoClobber;
    readNote(path: string): Promise<ParsedNote>;
    writeNote(params: NoteWriteParams): Promise<void>;
    patchNote(params: PatchNoteParams): Promise<PatchNoteResult>;
    listDirectory(path?: string): Promise<DirectoryListing>;
    exists(path: string): Promise<boolean>;
    isDirectory(path: string): Promise<boolean>;
    deleteNote(params: DeleteNoteParams): Promise<DeleteResult>;
    moveNote(params: MoveNoteParams): Promise<MoveResult>;
    moveFile(params: MoveFileParams): Promise<MoveResult>;
    /**
     * Resolve Obsidian's configured attachment folder, for bare-name uploads
     * (design brief I9). Reads `.obsidian/app.json` directly with `fs` — this
     * is an internal implementation detail, never exposed as a tool, and
     * `.obsidian/` itself stays blocked by PathFilter for every other path.
     * Returns undefined (meaning: vault root) when the file is missing,
     * unreadable, invalid JSON, `attachmentFolderPath` is absent/not a string/
     * "/", or note-relative (starts with "./" — unsupported here since there is
     * no "current note" for a standalone upload call; user decision: fall back
     * to vault root rather than guess).
     */
    private readAttachmentFolderPath;
    /**
     * Decide the actual upload target before any of I1's checks run (design
     * brief I9). The bare/explicit distinction is made on the raw input,
     * before normalizePath's own leading-slash stripping would erase it:
     *   - leading "/": vault root, explicitly — bypasses any configured
     *     attachment folder even if one is set.
     *   - contains "/" (no leading slash): an explicit relative path, used
     *     exactly as given (parent directories are created as needed).
     *   - bare file name (no "/" at all): placed in Obsidian's configured
     *     attachment folder, or vault root when none is configured/valid.
     * The result still goes through normalizePath and every I1 check exactly
     * like any other path — a malicious app.json pointing at `.git` is refused
     * there, not here.
     */
    private resolveUploadTargetPath;
    /**
     * Upload a file (any extension, including none) into the vault from
     * either base64-encoded content or a downloaded `file` source — exactly
     * one of the two (I6). See design brief .aicc/design/vault-upload.md for
     * the full invariant list (I1-I9); this method is the single owner of
     * all of them except I4 (atomicWrite/createNoClobber) and I7 (download.ts).
     */
    uploadFile(params: UploadFileParams): Promise<UploadResult>;
    readMultipleNotes(params: BatchReadParams): Promise<BatchReadResult>;
    updateFrontmatter(params: UpdateFrontmatterParams): Promise<void>;
    getNotesInfo(paths: string[]): Promise<NoteInfo[]>;
    manageTags(params: TagManagementParams): Promise<TagManagementResult>;
    getVaultPath(): string;
    /**
     * Resolve an Obsidian wiki link name to its vault-relative paths.
     * Scans the vault for exact filename matches (name + .md).
     *
     * A name containing `/` is path-qualified (Obsidian emits these when a
     * basename is ambiguous, e.g. [[folder/Note]]): it must match the full
     * vault-relative path instead of just the basename.
     *
     * Returns all matches sorted root-first (by path depth ascending), with
     * alphabetical tiebreak at equal depth. Empty array on zero matches.
     * The caller decides how to handle zero/single/multi — this function does
     * not throw on lookup outcomes.
     *
     * Throws only on caller misuse (empty name).
     */
    findPathForWikiLink(wikiLinkName: string): Promise<string[]>;
    getNoteOutline(path: string): Promise<NoteHeading[]>;
    readNoteLines(params: ReadNoteLinesParams): Promise<string>;
    getVaultStats(recentCount?: number): Promise<VaultStats>;
    listAllTags(): Promise<Array<{
        tag: string;
        count: number;
    }>>;
}
//# sourceMappingURL=filesystem.d.ts.map