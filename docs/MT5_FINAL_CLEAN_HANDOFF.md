# MT5 Master Handoff

`final-clean-manual` is not a valid template source. Clone testing from that folder still produced immediate `err=4014` on first launch and after a clean restart.

Use a dedicated clean master instead:

- Portable MT5 folder: `C:\MT5_MASTER`
- Launch helper: `setup_mt5_master.ps1`
- Validation helper: `validate_mt5_master.ps1`

Required operator sequence:

1. Run `setup_mt5_master.ps1`.
2. In the launched MT5 instance, use `File -> Open Data Folder` and confirm it opens `C:\MT5_MASTER`.
3. Open `Tools -> Options -> Expert Advisors`.
4. Enable algo trading as required and add `https://ifx-mt5-portal-production.up.railway.app`.
5. Click `OK`, wait 5-10 seconds, then close MT5 using `File -> Exit`.
6. Reopen `C:\MT5_MASTER\terminal64.exe /portable`.
7. Confirm the URL is still present.
8. Attach a test EA that performs WebRequest and confirm there is no `err=4014`.
9. Run `validate_mt5_master.ps1` and review its checklist output.

Only after those checks pass should `.env` set `MT5_TEMPLATE_DIR=C:\MT5_MASTER`.
