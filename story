#!/usr/bin/env sh
exec node "$(dirname "$0")/dist/src/cli/index.js" "$@"