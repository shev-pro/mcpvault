export interface ParsedCliArgs {
    vaultPathArg: string;
    readOnly: boolean;
    excludePaths: string[];
    maxUploadMb?: number;
}
export declare function parseCliArgs(args: string[]): ParsedCliArgs;
//# sourceMappingURL=cli.d.ts.map