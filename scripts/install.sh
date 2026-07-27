#!/usr/bin/env bash
#
# Vigyl quickstart installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ankithm-113/vigyl/main/scripts/install.sh | bash
#
# Installs @vigyl/cli globally and tells you what to do next. It does not run
# anything in your project and does not touch any credentials.
#
# If you would rather read before running (reasonable — you are piping a script
# from the internet into a shell), everything it does is: check Node, run
# `npm install -g @vigyl/cli`, print instructions.

set -euo pipefail

PACKAGE="@vigyl/cli"
MIN_NODE_MAJOR=20

# Colours only when attached to a terminal, so piped output stays clean.
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

info()  { printf '%s\n' "$*"; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()   { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

printf '\n%sVigyl%s — your infrastructure, in your pocket.\n\n' "$BOLD" "$RESET"

# --- prerequisites -----------------------------------------------------------

command -v node >/dev/null 2>&1 || die "Node is not installed. Vigyl needs Node ${MIN_NODE_MAJOR}+. See https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "npm is not installed. It normally ships with Node."

NODE_VERSION="$(node --version)"          # e.g. v24.13.1
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  die "Node ${NODE_VERSION} found, but Vigyl needs ${MIN_NODE_MAJOR} or newer."
fi
ok "Node ${NODE_VERSION}"

# --- install -----------------------------------------------------------------

info "${DIM}Installing ${PACKAGE}...${RESET}"

if npm install -g "$PACKAGE"; then
  ok "Installed ${PACKAGE}"
else
  # The overwhelmingly common cause, and one people waste time on.
  warn "Global install failed. This is usually a permissions problem."
  info ""
  info "  Either configure npm to install globally without sudo:"
  info "    ${DIM}https://docs.npmjs.com/resolving-eacces-permissions-errors${RESET}"
  info ""
  info "  Or install into your project instead:"
  info "    ${DIM}npm install --save-dev ${PACKAGE} && npx vigyl init${RESET}"
  exit 1
fi

if ! command -v vigyl >/dev/null 2>&1; then
  warn "Installed, but 'vigyl' is not on your PATH."
  info "  Try: ${DIM}export PATH=\"\$(npm prefix -g)/bin:\$PATH\"${RESET}"
fi

# --- what next ---------------------------------------------------------------

cat <<'NEXT'

Next:

  1. Create a Telegram bot — message @BotFather, send /newbot
  2. Get an Anthropic API key — https://console.anthropic.com
  3. In the project you want to control:

       cd your-project
       vigyl init      # validates both credentials before writing anything
       vigyl start

  Stuck? Run `vigyl doctor` — it checks everything and says what is wrong.

NEXT
