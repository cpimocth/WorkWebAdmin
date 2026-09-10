CPI Task System - อ่าน Excel อัตโนมัติ

วิธีใช้ที่แนะนำ
1. เก็บไฟล์ทั้งหมดไว้ในโฟลเดอร์เดียวกัน
2. Excel ต้องใช้ชื่อ Database_CPI.xlsx
3. ดับเบิลคลิก "เปิดระบบ_CPI.bat"
4. ระบบจะเปิดหน้าเว็บอัตโนมัติที่ http://127.0.0.1:8765/index.html
5. หน้าเว็บจะอ่าน Database_CPI.xlsx โดยตรงทุกครั้งที่โหลด/Refresh
6. เมื่อแก้ Excel: Save -> กลับหน้าเว็บ -> Refresh

ข้อดีของโหมดนี้
- ไม่ต้องกดเลือก Excel
- ไม่ต้องใช้อินเทอร์เน็ตเพื่ออ่าน Excel
- server.py ใช้ Python มาตรฐานได้ แม้เครื่องไม่มี openpyxl
- Database_CPI.xlsx ยังเป็นฐานข้อมูลหลัก ไม่ต้องแก้ข้อมูลใน HTML

หากเปิด index.html โดยตรง
- Chrome/Edge ใช้ file:// และไม่อนุญาตให้ JavaScript อ่านไฟล์ Excel ข้างเคียงแบบอัตโนมัติ
- เว็บจึงใช้ฐานล่าสุด 131 บัญชีที่ฝังไว้เป็น fallback

สำหรับ GitHub Pages/Web Server
- วาง Database_CPI.xlsx ไว้โฟลเดอร์เดียวกับ index.html
- เว็บจะพยายามอ่าน Excel อัตโนมัติผ่าน HTTP เช่นเดิม
