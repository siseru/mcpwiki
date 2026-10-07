// Build information. esbuild replaces __MCPWIKI_VERSION__ (scripts/build.mjs): the release tag for tag
// builds, otherwise `git describe` (e.g. v0.3.0-4-g1a2b3c4); plain tsc output (tests) reports "dev".
declare const __MCPWIKI_VERSION__: string | undefined;

export const VERSION: string = typeof __MCPWIKI_VERSION__ === 'string' ? __MCPWIKI_VERSION__ : 'dev';
export const REPOSITORY_URL = 'https://github.com/siseru/mcpwiki';
