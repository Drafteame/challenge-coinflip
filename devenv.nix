# Development environment for the Draftea coin-flip mock game server.
#
# The deliverable itself stays a plain npm project (`.nvmrc` + `package.json`
# `engines`); this shell only provides Node + pnpm so the project can be
# built and its tests run from a clean machine.
#
# Node: prompt.md targets Node 26, but the company uses Node 24 in its own
# devenv shells (see platform-idp). Node 24.12+ ships the same stable TS type
# stripping, so `node src/main.ts` + `tsc --noEmit` behave identically on both.
{ pkgs, ... }:

{
  packages = [
    pkgs.nodejs_24
    pkgs.pnpm
  ];

  enterShell = ''
    # Let locally-installed project binaries (tsc, etc.) win over global ones.
    export PATH="$PWD/node_modules/.bin:$PATH"
  '';
}