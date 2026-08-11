#!/usr/bin/env sh
# Roleplay Card Converter - start on macOS / Linux
#
# The Windows equivalent is "Start Card Converter.vbs". Both do the same thing:
# start the local server and open the tool in your browser.
#
#   ./start.sh          start and open a browser
#   ./start.sh --quiet  start without opening one
#
# If it will not run, make it executable first:  chmod +x start.sh

cd "$(dirname "$0")" || exit 1

if ! command -v node > /dev/null 2>&1; then
  echo "Node.js is not installed, or is not on your PATH."
  echo "Install it from https://nodejs.org and run this again."
  exit 1
fi

if [ "$1" = "--quiet" ]; then
  exec node proxy.js
else
  exec node proxy.js --open
fi
