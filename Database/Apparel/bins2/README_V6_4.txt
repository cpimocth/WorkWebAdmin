CPI Price Web V6.4
==================

กติกา Master ใหม่
- รหัสรายการ / รหัสหมวด / CODE7: บังคับ 7 หลัก
- รหัสสินค้า / COMMODITY_CODE: ไม่บังคับ; ถ้ากรอกต้อง 16 หลัก และ 7 ตัวแรกต้องตรง CODE7
- รหัสแหล่ง / DILLER_CODE / SHOP_CODE: ไม่บังคับ; ถ้ากรอกต้อง 10 หลัก
- ไม่มีคอลัมน์รหัสสินค้า/รหัสแหล่งใน Excel ก็ Import ได้
- ช่องว่างของสองรหัสดังกล่าวจะเก็บเป็น NULL ใน Supabase

การติดตั้ง
1) ถ้ามีฐาน V6.3 เดิมและต้องการเก็บข้อมูล: Run supabase_upgrade_v6_4.sql
2) ถ้าต้องการล้างข้อมูลทั้งหมดและเริ่มใหม่: Run supabase_reset_v6_4.sql แทน (ไม่ต้อง Run Upgrade)
3) ใช้ index.html V6.4

หมายเหตุ
- Reset เป็น destructive operation และลบ price_master/monthly_prices เดิมทั้งหมด
- Logic V6.3 อื่น ๆ ยังคงเดิม: G/L/U/N เดือนชนเดือน, N exclusive, ราคาเดือนก่อน, ภาวะผู้ตรวจ -> ภาวะผู้บันทึกเดือนถัดไป, Link N/1/2/3, REL 5 ตำแหน่ง
