import { Server } from "@modelcontextprotocol/server";
import { FrontmatterHandler } from "./frontmatter.js";
import { PathFilter } from "./pathfilter.js";
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
/**
 * Stdio read-buffer size that lets one upload_file call carry a base64 file at
 * the upload limit: base64 is 4/3 of the bytes, plus the JSON-RPC envelope.
 * Without it the SDK's 10 MiB default drops the connection on uploads above
 * ~7.5 MiB. Never below the SDK default.
 */
export declare function stdioMaxBufferSize(maxUploadBytes?: number): number;
export declare function createServer(vaultPath: string, options?: CreateServerOptions): Server;
//# sourceMappingURL=createServer.d.ts.map