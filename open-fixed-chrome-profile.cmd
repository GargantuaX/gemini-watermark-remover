@echo off
setlocal
node "%~dp0scripts\open-tampermonkey-profile.js" --cdp-port 9226 --url "http://127.0.0.1:4173/tampermonkey-worker-probe.html"

