// Build information. esbuild replaces __MCPWIKI_VERSION__ (scripts/build.mjs): the release tag for tag
// builds, otherwise `git describe` (e.g. v0.3.0-4-g1a2b3c4); plain tsc output (tests) reports "dev".
// __MCPWIKI_REPOSITORY__ is the "repository" field of package.json (forks change it there).
declare const __MCPWIKI_VERSION__: string | undefined;
declare const __MCPWIKI_REPOSITORY__: string | undefined;

export const VERSION: string = typeof __MCPWIKI_VERSION__ === 'string' ? __MCPWIKI_VERSION__ : 'dev';
/** Source repository linked from the footer; empty when package.json has none. */
export const REPOSITORY_URL: string = typeof __MCPWIKI_REPOSITORY__ === 'string' ? __MCPWIKI_REPOSITORY__ : '';
