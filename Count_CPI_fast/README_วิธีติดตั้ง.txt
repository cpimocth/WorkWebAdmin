CPI FIELDPULSE - GitHub Pages FastDB
=================================

เป้าหมาย
- เก็บไฟล์ Excel G/L/U และ Real_Master_CPI ไว้ใน GitHub repository เช่นเดิม
- เมื่อ GitHub มีการอัปเดต Excel ให้ GitHub Actions สร้างฐานข้อมูลอ่านเร็วเป็น JSON.gz
- ผู้เปิดหน้าเว็บจะดาวน์โหลดเฉพาะข้อมูลเดือนล่าสุดและเดือนก่อน แล้วแสดงผลทันที
- แสดงข้อมูลสเปค, CODE7, Master, พื้นที่ และเปรียบเทียบเดือนก่อนด้วยตรรกะเดิม
- ไม่ต้องดาวน์โหลดและแตก Excel ในเบราว์เซอร์ทุกครั้ง

ติดตั้งครั้งแรก (ใช้ GitHub Pages)
1. แตก ZIP ไฟล์นี้และคัดลอกโครงสร้างเดิมลงไปใน Repository:
   index.html
   scripts/build_fastdb.py
   .github/workflows/cpi-fastdb-pages.yml

2. เก็บ Real_Master_CPI*.xlsx และไฟล์เก็บราคา 4.1.*.xlsx ไว้ที่ใดก็ได้ใน Repository
   (รวมถึง subfolder data/, excel/, inputs/).
   ระบบเลือก Real_Master_CPI.xlsx หากมี หรือเลือกชื่อ Master ที่มีเวอร์ชันสูงสุด
   และเลือกไฟล์ชุด 4.1.x.x ที่มีเวอร์ชันสูงสุดใน path เดียวกัน

3. ไปที่ GitHub -> Repository -> Settings -> Pages
   Source = GitHub Actions (แทน Deploy from a branch)
   หากระบบยังไม่อนุญาต GitHub Actions ให้เปิดสิทธิ์ใช้งาน Workflow

4. Commit ไฟล์ข้างต้นเข้า default branch (ปกติ main)
   ไปที่ Actions -> CPI FastDB + GitHub Pages -> Run workflow
   เพื่อสร้างเว็บไซต์ครั้งแรก หรือรอ workflow จาก push บน branch ที่เป็นค่าเริ่มต้น

5. เปิดลิงก์เว็บไซต์ GitHub Pages ตามที่ Repo แจ้ง
   เว็บจะอ่าน fastdb/manifest.json อัตโนมัติ (ไม่เรียก GitHub API หากพบ FastDB)
   จะมีข้อความ "FastDB พร้อมใช้" เหนือ Dashboard
   เลือก "ทุกเขต / ทุกกลุ่มเก็บราคา" เพื่อแสดงภาพรวม

การอัปเดตหลังจากนั้น
- Upload หรือ replace Excel บน GitHub Repository
- Action ทำงานเฉพาะตอนมีการเปลี่ยนแปลง Excel หรือโค้ดตาม paths ที่กำหนด
- หลัง Deployment สำเร็จ หน้าเว็บจะพบ manifest เวอร์ชันใหม่เมื่อเปิด/กดอัปเดตจาก Git
- ชาร์ดราคาใช้ชื่อผูกกับ SHA256 ไฟล์ต้นทาง จึงไม่ใช้ไฟล์เก่าผิดเวอร์ชัน
- เดือนเก่าโหลดเฉพาะตอนเลือกเดือนนั้น ไม่ดาวน์โหลดทุกเดือนไว้ล่วงหน้า

พฤติกรรมทางสำรอง
- ถ้าไม่มี FastDB (เช่นยังไม่ได้ Deploy) HTML จะกลับไปใช้วิธีเดิมที่อ่าน XLSX จาก GitHub
- ยังรองรับอัปโหลด Excel และเปิดโฟลเดอร์ Excel ด้วยตนเอง
- เปิด index.html ด้วย file:// ไม่สามารถอ่าน FastDB ข้างเคียงอัตโนมัติเหมือน GitHub Pages;
  แนะนำให้เปิดผ่าน GitHub Pages เพื่อใช้ความเร็วสูงสุด

ข้อควรระวัง
- GitHub Pages เป็นเว็บไซต์สาธารณะ และไฟล์ FastDB ที่เผยแพร่สามารถดาวน์โหลดได้
  อย่าเผยแพร่ข้อมูลราคาที่มีข้อจำกัดการเข้าถึง ข้อมูลส่วนบุคคล หรือความลับของหน่วยงาน
- ถ้าต้องจำกัดสิทธิ์ผู้ใช้ ให้เปลี่ยนไปใช้ Backend Database + Authentication
  เช่น PostgreSQL/Supabase, Cloudflare D1 + Worker แทน Static Pages
- Workflow นี้เผยแพร่เพียง index.html กับ JSON.gz ที่สร้างแล้ว ไม่เผยแพร่ไฟล์ .xlsx ดิบ
  แต่ FastDB ที่บีบอัดยังมีรายละเอียดสเปคและข้อมูลราคาอยู่ ไม่ใช่ข้อมูลนิรนาม
- บน Repository ที่มี GitHub Pages หรือ deployment workflow อื่นอยู่แล้ว ควรปิด workflow เก่า
  หรือรวมขั้นตอน deploy ให้เป็นอันเดียว เพื่อไม่ให้ workflow สองชุดแย่ง deploy
- หากเว็บไซต์ต้องมีไฟล์ assets/ หรือหน้าเว็บอื่น ๆ ให้เพิ่มการคัดลอกลง _site ใน workflow

เกี่ยวกับข้อมูล
- รักษา 1 แถวเก็บราคาตามข้อมูล Excel ต้นทาง, G/L/U, รหัสสินค้า 16 ตัว,
  จังหวัด, แหล่งเก็บราคา, ลักษณะจำเพาะ และป้ายเดือน
- Master แปลงผังพื้นที่และธงการเก็บในชีตคำนวณโดยอาศัยค่าจริง ไม่เดาจังหวัด
- จำนวนจริง, เป้าหมาย และเปอร์เซ็นต์ที่รายงานคำนวณใน HTML ตามตรรกะเดิม
- ระบบไม่ได้รับรองเวลาโหลดบนเครือข่าย GitHub ของทุกเครื่อง ความเร็วจะแปรตามขนาดและเครือข่าย

การแก้ไขเบื้องต้น
- Action ล้มเหลว: เปิดแท็บ Actions > CPI FastDB + GitHub Pages > build/deploy log
- ไม่พบ Master: ตรวจชื่อไฟล์ Real_Master_CPI*.xlsx และชีต "ข้อมูล_รายการ_ผู้ดูแล"
- ไม่พบไฟล์เก็บราคา: ตรวจชื่อ 4.1.*.xlsx หรือวางในโฟลเดอร์ data/, excel/, inputs/
- เว็บไซต์ยังโหลด Excel เดิม: ตรวจ fastdb/manifest.json ที่เว็บไซต์ GitHub Pages
  และตรวจว่ากำหนด Source=GitHub Actions เรียบร้อย
