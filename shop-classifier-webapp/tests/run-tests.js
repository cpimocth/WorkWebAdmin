const assert = require("assert");
const fs = require("fs");
const path = require("path");
const classifier = require("../classifier.js");
const miniXlsx = require("../mini-xlsx.js");

(async () => {
  assert.strictEqual(classifier.DEFAULT_RULES.length, 23, "default rule count");

  const cases = [
    ["ร้านข้าวสาร (พรชัยค้าข้าว)", "ร้านอื่นๆ"],
    ["ท็อปส์ เดลี่ สาขาสุขุมวิท", "Tops_daily"],
    ["ห้างท็อปส์ สาขารังสิต", "Tops"],
    ["โลตัส โกเฟรช (ตลาดไทเลย)", "Lotus_gofresh"],
    ["ห้างเทสโก้ โลตัส", "Tesco Lotus"],
    ["บิ๊กซี มินิ", "BigC_mini"],
    ["บิ๊กซี ซูเปอร์เซ็นเตอร์", "Big C"],
    ["กูรเมต์ มาร์เก็ต The Mall Bangkapi", "Gourmet Market"],
    ["ร้านที่ไม่ตรงกติกา", "ไม่พบเงื่อนไข"]
  ];

  for (const [name, expected] of cases) {
    const actual = classifier.classifyName(name, classifier.DEFAULT_RULES, { mode: "smart", unmatchedValue: "ไม่พบเงื่อนไข" });
    assert.strictEqual(actual.result, expected, name);
  }

  const rowOrder = classifier.classifyName("กูรเมต์ มาร์เก็ต The Mall Bangkapi", classifier.DEFAULT_RULES, { mode: "row-order" });
  assert.strictEqual(rowOrder.result, "The Mall", "row-order mode must follow spreadsheet order");

  const workbookPath = path.resolve(__dirname, "../shop.xlsx");
  const workbook = await miniXlsx.readWorkbook(fs.readFileSync(workbookPath));
  assert.deepStrictEqual(workbook.sheetNames, ["Sheet1"]);
  assert.strictEqual(workbook.sheets[0].rows[0][0], "Result");
  assert.strictEqual(workbook.sheets[0].rows.length, 24);

  const testRows = [
    ["SHOP_NAME", "SHOP_RESULT"],
    ["ห้างโลตัส", "Tesco Lotus"],
    ["บิ๊กซี มินิ", "BigC_mini"]
  ];
  const output = miniXlsx.writeWorkbook([{ name: "Result", rows: testRows }]);
  const reparsed = await miniXlsx.readWorkbook(output);
  assert.deepStrictEqual(reparsed.sheets[0].rows, testRows);

  const sampleLines = fs.readFileSync(path.resolve(__dirname, "../sample-shop-names.txt"), "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line, index) => !(index === 0 && classifier.normalizeText(line) === "shop_name"))
    .filter((line) => classifier.normalizeText(line));
  assert.strictEqual(sampleLines.length, 1025);
  const sampleResults = sampleLines.map((line) => classifier.classifyName(line, classifier.DEFAULT_RULES, { mode: "smart", unmatchedValue: "ไม่พบเงื่อนไข" }));
  const summary = classifier.summarize(sampleResults);
  assert.strictEqual(summary.total, 1025);
  assert.strictEqual(summary.matched, 644);
  assert.strictEqual(summary.unmatched, 381);

  console.log("All tests passed");
  console.log(JSON.stringify(summary, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
