$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $scriptDir 'scripts/open-tampermonkey-profile.js'

node $entry --cdp-port 9226 --url 'http://127.0.0.1:4173/tampermonkey-worker-probe.html'
