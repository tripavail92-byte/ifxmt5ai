# Final Clean MT5 Handoff

Prepared terminal:

- Portable MT5 folder: `C:\mt5system\terminals\final-clean-manual`
- EA binary already copied into `MQL5\Experts\IFX\IFX_Railway_Bridge_v1.ex5`
- EA preset already copied into `MQL5\Presets\ifx_connection.set`
- Bootstrap payload already copied into `MQL5\Files\ifx\bootstrap.json`

Manual setup sequence:

1. Run `start_final_clean_terminal_normal.ps1` or launch `terminal64.exe` from `C:\mt5system\terminals\final-clean-manual` in portable mode.
2. In MT5, log in manually if needed.
3. Open Tools -> Options -> Expert Advisors.
4. Add `https://ifx-mt5-portal-production.up.railway.app` to `Allow WebRequest for listed URL`.
5. In Navigator, attach `IFX_Railway_Bridge_v1` from `Experts > IFX` to a chart.
6. When the EA input dialog opens, load `ifx_connection.set` if MT5 does not load it automatically.
7. Confirm the EA shows a smiling icon / active state on the chart.
8. Close MT5 normally.

After that, keep using the same portable terminal folder for manual testing.

Validation target after the manual attach:

- The WebRequest allow-list entry still exists after restart.
- The Experts log no longer shows `err=4014` for `/api/mt5` requests.
