#!/bin/bash
# Linux packaging wrapper (npm run package:linux).
#
# Only environment setup lives here — the packaging itself is scripts/package.mjs, the same
# script the Windows target uses, so both targets agree on how the version is derived, how
# it is written into package.json and which architecture is requested.
set -e

unset npm_config_prefix

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    nvm use 22
else
    echo "nvm not found, using system node ($(node --version))"
fi

# Use Chinese mirror to download Electron binary.
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

npm run build
exec node scripts/package.mjs --linux
