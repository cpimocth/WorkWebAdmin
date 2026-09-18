CPI Price Web V6.3

G/L/U/N month-to-month behavior
1. New month inherits G/L/U/N from the immediately previous month.
2. If previous month has no row, it falls back to Master.
3. If you change G/L/U/N and click Save All, that month becomes the saved source.
4. Future months inherit the newly saved selection.
5. If a future month was already prepared but its G/L/U/N was not manually overridden, it will stay synchronized.
6. Once a future month has its own G/L/U/N change saved, older months no longer overwrite that selection.
7. N remains exclusive: N clears G/L/U, and selecting G/L/U clears N.

Install
- Run supabase_upgrade_v6_3.sql once.
- Replace the current index.html with this V6.3 index.html.

RESET V6.3 (DESTRUCTIVE)
- supabase_reset_v6_3.sql = ลบข้อมูล price_master และ monthly_prices ทั้งหมด แล้วสร้างฐาน V6.3 ใหม่
- ใช้เฉพาะกรณีต้องการเริ่มระบบใหม่ทั้งหมด
