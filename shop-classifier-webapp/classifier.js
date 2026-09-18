(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ShopClassifier = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_RULE_ROWS = [
    { rowNumber: 2, result: "ร้านอื่นๆ", primaryKeywords: "ร้านหน้าโลตัส, ปลาผา, WASH, Amazon, เอเมซอน, คาเฟ่, Cafe, ศูนย์อาหาร, อาหาร, ร้านยา, ขายยา, ข้าว, DRUG, เอเซ่เว่น", subKeywords: "" },
    { rowNumber: 3, result: "ไทวัสดุ", primaryKeywords: "ไทวัสดุ, วัตดุ", subKeywords: "" },
    { rowNumber: 4, result: "Watson", primaryKeywords: "วัตสัน, Watson", subKeywords: "" },
    { rowNumber: 5, result: "Unico", primaryKeywords: "Uni", subKeywords: "" },
    { rowNumber: 6, result: "Tops_daily", primaryKeywords: "Tops, ท็อปส์, ท็อปน์,ท็อปน์ (เซ็นทรัล นนทบุรี), Tops, ท็อปส์,ท็อปส์ เดลี่, ท็อปส์ มาร์เก็ต, ท็อปส์มาร์เก็ต, Tops, ห้างท็อปส์, TOPS", subKeywords: "เดลี่" },
    { rowNumber: 7, result: "Tops", primaryKeywords: "ท็อปน์ (เซ็นทรัล นนทบุรี), Tops, ท็อปส์,ท็อปส์ เดลี่, ท็อปส์ มาร์เก็ต, ท็อปส์มาร์เก็ต, Tops, ห้างท็อปส์, TOPS", subKeywords: "" },
    { rowNumber: 8, result: "The Mall", primaryKeywords: "เดอะมอลล์, mall, Mall", subKeywords: "" },
    { rowNumber: 9, result: "Tesco Lotus", primaryKeywords: "โลตัส, Lotus, Tesco, โลตัล, Lotus's,โลตัส, Lotus, Tesco, โลตัล, ไฮเปอร์", subKeywords: "" },
    { rowNumber: 10, result: "Seven Eleven", primaryKeywords: "7-ELEVEN, เซ่เว่น,อีเลฟเว่น, ELEVEN, 7 - 11, 7-11, 7-ELEVEN, เซเว่น, 7-Eleven, seven, SEVEN, Eleven, เซ่เว่น", subKeywords: "" },
    { rowNumber: 11, result: "Powerbuy", primaryKeywords: "buy, พาวเวอร์", subKeywords: "" },
    { rowNumber: 12, result: "MegaHome", primaryKeywords: "เมกะโฮม, MegaHome", subKeywords: "" },
    { rowNumber: 13, result: "Maxvalue", primaryKeywords: "Maxvalue, แม็กซ์แวลู, Max Valu", subKeywords: "" },
    { rowNumber: 14, result: "Makro", primaryKeywords: "แม็คโคร, แม็คโค, เเม็คโค, Makro,แม็คโค, เเม็คโค", subKeywords: "" },
    { rowNumber: 15, result: "Lotus_gofresh", primaryKeywords: "โลตัส, tesco, Tesco, โลตัล, Lotus,โลตัส, Lotus, Tesco, โลตัล", subKeywords: "เฟรซ, เฟรช, โก, exp, gofresh, โก้" },
    { rowNumber: 16, result: "Homepro", primaryKeywords: "โฮมโปร, Homepro,HomePro,Home Pro,โฮม โปร", subKeywords: "" },
    { rowNumber: 17, result: "Gourmet Market", primaryKeywords: "กูรเมต์, กูร์เมต์,กูร์เมต์,กรูเม่,Gourmet", subKeywords: "" },
    { rowNumber: 18, result: "GlobalHouse", primaryKeywords: "โกบอล, โกลบอล, โกลบอน, Global", subKeywords: "" },
    { rowNumber: 19, result: "DoHome", primaryKeywords: "ดโฮม, ดูโฮม, DoHome", subKeywords: "" },
    { rowNumber: 20, result: "CP Freshmart", primaryKeywords: "เฟรชมาร์ท, Freshmat", subKeywords: "" },
    { rowNumber: 21, result: "CJ EXPRESS", primaryKeywords: "CJ EXPRESS,CJ, ซี เจ, ซีเจ, Cj Express, Cj MORE", subKeywords: "" },
    { rowNumber: 22, result: "Central", primaryKeywords: "เซนทรัล, CENTRAL, เซ็นทรัล,Central,Central,เซนทรัล, CENTRAL, เซ็นทรัล", subKeywords: "" },
    { rowNumber: 23, result: "BigC_mini", primaryKeywords: "Big C, บิ๊กซี, บิกซี, BigC", subKeywords: "มินิ, Mini, mini" },
    { rowNumber: 24, result: "Big C", primaryKeywords: "บิ๊กซี, บิกซี, Big C, Big-C,Big C, บิ๊กซี, บิกซี, Big-C, BigC", subKeywords: "" }
  ];

  function normalizeText(value) {
    let text = value == null ? "" : String(value);
    if (typeof text.normalize === "function") text = text.normalize("NFKC");
    return text
      .toLocaleLowerCase("th-TH")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitKeywords(value) {
    if (value == null || value === "") return [];
    const seen = new Set();
    const output = [];
    String(value)
      .split(/[,\n\r]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((raw) => {
        const normalized = normalizeText(raw);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        output.push({ raw, normalized, length: Array.from(normalized).length });
      });
    return output;
  }

  function prepareRules(rows) {
    return (rows || [])
      .map((row, index) => {
        const result = row.result ?? row.Result ?? row.RESULT ?? "";
        const primaryValue = row.primaryKeywords ?? row["Primary Keywords"] ?? row.primary ?? "";
        const subValue = row.subKeywords ?? row["Sub Keywords"] ?? row.sub ?? "";
        const rowNumber = Number(row.rowNumber ?? row.ruleRow ?? index + 2);
        const primary = splitKeywords(primaryValue);
        const sub = splitKeywords(subValue);
        return {
          index,
          rowNumber: Number.isFinite(rowNumber) ? rowNumber : index + 2,
          result: String(result || "").trim(),
          primaryKeywords: String(primaryValue || ""),
          subKeywords: String(subValue || ""),
          primary,
          sub
        };
      })
      .filter((rule) => rule.result && rule.primary.length > 0);
  }

  function isDelimiter(char) {
    return !char || /[\s()[\]{}.,/\\:;|'"_+\-=–—]/u.test(char);
  }

  function findKeyword(normalizedText, keyword, options) {
    const opts = options || {};
    const requireTokenStart = Boolean(opts.requireTokenStart);
    let start = 0;
    let best = null;
    while (start <= normalizedText.length) {
      const index = normalizedText.indexOf(keyword.normalized, start);
      if (index < 0) break;
      const previous = index === 0 ? "" : normalizedText[index - 1];
      if (!requireTokenStart || isDelimiter(previous)) {
        best = { raw: keyword.raw, normalized: keyword.normalized, index, length: keyword.length };
        break;
      }
      start = index + 1;
    }
    return best;
  }

  function bestKeywordMatch(normalizedText, keywords, isSubKeyword) {
    let best = null;
    for (const keyword of keywords) {
      const shortSubKeyword = Boolean(isSubKeyword && keyword.length <= 3);
      const match = findKeyword(normalizedText, keyword, { requireTokenStart: shortSubKeyword });
      if (!match) continue;
      if (
        !best ||
        match.index < best.index ||
        (match.index === best.index && match.length > best.length)
      ) {
        best = match;
      }
    }
    return best;
  }

  function matchRule(name, rule) {
    const normalizedName = normalizeText(name);
    if (!normalizedName) return null;
    const primary = bestKeywordMatch(normalizedName, rule.primary, false);
    if (!primary) return null;
    let sub = null;
    if (rule.sub.length > 0) {
      sub = bestKeywordMatch(normalizedName, rule.sub, true);
      if (!sub) return null;
    }
    return { primary, sub, normalizedName };
  }

  function compareSmartCandidates(a, b) {
    const aHasSub = a.rule.sub.length > 0 ? 1 : 0;
    const bHasSub = b.rule.sub.length > 0 ? 1 : 0;
    if (aHasSub !== bHasSub) return bHasSub - aHasSub;
    if (a.match.primary.index !== b.match.primary.index) {
      return a.match.primary.index - b.match.primary.index;
    }
    if (a.match.primary.length !== b.match.primary.length) {
      return b.match.primary.length - a.match.primary.length;
    }
    const aSubLength = a.match.sub ? a.match.sub.length : 0;
    const bSubLength = b.match.sub ? b.match.sub.length : 0;
    if (aSubLength !== bSubLength) return bSubLength - aSubLength;
    return a.rule.index - b.rule.index;
  }

  function classifyName(name, rules, options) {
    const opts = Object.assign(
      { mode: "smart", unmatchedValue: "ไม่พบเงื่อนไข" },
      options || {}
    );
    const preparedRules = rules && rules.length && rules[0].primary ? rules : prepareRules(rules || []);
    const candidates = [];

    for (const rule of preparedRules) {
      const match = matchRule(name, rule);
      if (!match) continue;
      const candidate = { rule, match };
      if (opts.mode === "row-order") {
        return {
          input: name == null ? "" : String(name),
          result: rule.result,
          matched: true,
          primaryKeyword: match.primary.raw,
          subKeyword: match.sub ? match.sub.raw : "",
          ruleRow: rule.rowNumber,
          mode: opts.mode
        };
      }
      candidates.push(candidate);
    }

    if (candidates.length === 0) {
      return {
        input: name == null ? "" : String(name),
        result: opts.unmatchedValue,
        matched: false,
        primaryKeyword: "",
        subKeyword: "",
        ruleRow: "",
        mode: opts.mode
      };
    }

    candidates.sort(compareSmartCandidates);
    const selected = candidates[0];
    return {
      input: name == null ? "" : String(name),
      result: selected.rule.result,
      matched: true,
      primaryKeyword: selected.match.primary.raw,
      subKeyword: selected.match.sub ? selected.match.sub.raw : "",
      ruleRow: selected.rule.rowNumber,
      mode: opts.mode
    };
  }

  function summarize(classifications) {
    const counts = new Map();
    let matched = 0;
    let unmatched = 0;
    for (const item of classifications || []) {
      if (item.matched) matched += 1;
      else unmatched += 1;
      counts.set(item.result, (counts.get(item.result) || 0) + 1);
    }
    return {
      total: matched + unmatched,
      matched,
      unmatched,
      counts: Array.from(counts.entries())
        .map(([result, count]) => ({ result, count }))
        .sort((a, b) => b.count - a.count || a.result.localeCompare(b.result, "th"))
    };
  }

  const DEFAULT_RULES = prepareRules(DEFAULT_RULE_ROWS);

  return {
    DEFAULT_RULE_ROWS,
    DEFAULT_RULES,
    normalizeText,
    splitKeywords,
    prepareRules,
    matchRule,
    classifyName,
    summarize
  };
});
