#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    source "$HOME/.nvm/nvm.sh"
  fi
fi
if ! command -v npm >/dev/null 2>&1; then
  print "Install Node.js 24 LTS, then launch this application again."
  read "?Press Return to close…"
  exit 1
fi
if [ ! -d node_modules ]; then
  print "First launch: installing dependencies…"
  npm ci || { read "?Installation failed. Check your connection. Press Return to close…"; exit 1; }
fi
print "Starting Repair Task Export. Keep this window open; press Control+C to stop."
print "Open: http://localhost:3000"
FESTO_OPEN_BROWSER=1 npm run dev
read "?The application has stopped. Press Return to close…"
