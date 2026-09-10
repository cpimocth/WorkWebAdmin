ไฟล์ที่ต้องอัปขึ้น GitHub Pages (ให้อยู่โฟลเดอร์เดียวกัน)
1) index.html
2) Database_CPI.xlsx
3) jszip.min.js

วิธีทดสอบ
- เปิด GitHub Pages URL จริง เช่น https://USERNAME.github.io/REPOSITORY/
- หน้าเว็บจะอ่าน Database_CPI.xlsx อัตโนมัติ
- ถ้าสำเร็จจะขึ้นสีเขียว พร้อมจำนวนชีท / Users / Tasks และตัวอย่างข้อมูล
- ถ้าไม่สำเร็จ หน้าเว็บจะแสดง URL ที่พยายามอ่านและ HTTP error จริง

หมายเหตุ
- ชื่อ Database_CPI.xlsx ต้องตรงตัว (ตัวใหญ่/เล็กมีผลบน GitHub)
- ทั้ง 3 ไฟล์ต้องอยู่ในโฟลเดอร์ที่ GitHub Pages deploy จริง เช่น root หรือ docs ตามที่ตั้งค่า Pages
- jszip.min.js รวมไว้ local แล้ว ไม่ต้องพึ่ง CDN
