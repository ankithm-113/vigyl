# Vigyl quickstart installer for Windows.
#
#   irm https://raw.githubusercontent.com/nulldesk/vigyl/main/scripts/install.ps1 | iex
#
# Installs @vigyl/cli globally and tells you what to do next. It does not run
# anything in your project and does not touch any credentials.

$ErrorActionPreference = 'Stop'

$Package = '@vigyl/cli'
$MinNodeMajor = 20

function Write-Ok    { param($Text) Write-Host "> $Text" -ForegroundColor Green }
function Write-Warn  { param($Text) Write-Host "! $Text" -ForegroundColor Yellow }
function Write-Fail  { param($Text) Write-Host "x $Text" -ForegroundColor Red }

Write-Host ''
Write-Host 'Vigyl' -ForegroundColor White -NoNewline
Write-Host ' - your infrastructure, in your pocket.'
Write-Host ''

# --- prerequisites -----------------------------------------------------------

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Fail "Node is not installed. Vigyl needs Node $MinNodeMajor or newer. See https://nodejs.org"
  exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Fail 'npm is not installed. It normally ships with Node.'
  exit 1
}

$NodeVersion = (node --version)                       # e.g. v24.13.1
$NodeMajor = [int](($NodeVersion.TrimStart('v') -split '\.')[0])

if ($NodeMajor -lt $MinNodeMajor) {
  Write-Fail "Node $NodeVersion found, but Vigyl needs $MinNodeMajor or newer."
  exit 1
}
Write-Ok "Node $NodeVersion"

# --- install -----------------------------------------------------------------

Write-Host "Installing $Package..." -ForegroundColor DarkGray
npm install -g $Package

if ($LASTEXITCODE -ne 0) {
  Write-Warn 'Global install failed. This is usually a permissions problem.'
  Write-Host ''
  Write-Host '  Try an elevated PowerShell, or install into your project instead:'
  Write-Host "    npm install --save-dev $Package; npx vigyl init" -ForegroundColor DarkGray
  exit 1
}
Write-Ok "Installed $Package"

if (-not (Get-Command vigyl -ErrorAction SilentlyContinue)) {
  Write-Warn "Installed, but 'vigyl' is not on your PATH. Open a new terminal and try again."
}

# --- what next ---------------------------------------------------------------

Write-Host @'

Next:

  1. Create a Telegram bot - message @BotFather, send /newbot
  2. Get an Anthropic API key - https://console.anthropic.com
  3. In the project you want to control:

       cd your-project
       vigyl init      # validates both credentials before writing anything
       vigyl start

  Stuck? Run `vigyl doctor` - it checks everything and says what is wrong.

'@
