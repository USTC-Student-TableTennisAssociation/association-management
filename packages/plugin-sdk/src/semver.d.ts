declare module "semver" {
  interface SemVerOptions {
    includePrerelease?: boolean;
  }

  const semver: {
    valid(version: string, options?: SemVerOptions): string | null;
    validRange(range: string, options?: SemVerOptions): string | null;
    satisfies(version: string, range: string, options?: SemVerOptions): boolean;
  };

  export default semver;
}
