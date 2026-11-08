/**
 * 羽生AI 実績記録ツール
 *
 *   node tools/track.mjs commit "<予測CSV>"     レース前：予測の指紋(ハッシュ)だけを記録する（1日に何度でも可）
 *       オプション: --skip 中山5R[:理由]   AIの買い目を、羽生の判断で見送る（指紋に含める）
 *                   --add-csv <別の予測CSV> --add 京都7R[:理由]
 *                                          AIの記録には入れず、羽生の判断で別のCSV（例: ダート）のAI1位を買い足す。
 *                                          「AI＋羽生の判断」にだけ数え、「AIのみ」には数えない（指紋に含める）
 *   node tools/track.mjs reveal <日付>          レース後：その日の全ての版の中身を公開する
 *   node tools/track.mjs results "<結果CSV>"    結果を取り込み、的中率と回収率を集計する
 *   node tools/track.mjs verify                 公開済みの予測が、記録した指紋と一致するか確かめる
 *   node tools/track.mjs worldlog "<結果CSV>" [--dat <datファイル>] [--name "<表示名>"]
 *                                               重賞：実際の1〜3着が世界線（公開データの着順）の中にあったかを記録する
 *   node tools/track.mjs worldlog-payout "<全データCSV>"
 *                                               世界線ログの3連単配当を、全データCSVから埋める（無ければ空白のまま）
 *
 * 買い目は「AI勝率1位 かつ 期待値1.2以上（2026-10-24 以降。それ以前は1.3以上）の単勝」。障害競走は平地用モデルの対象外として除く。
 *
 * オッズで期待値が変わるため、1日に何度でも記録できる。すべての版が時刻付きで公開される。
 * 成績に数えるのは「各レースの発走時刻より前に記録された、最後の版」だけ。
 * レースが終わってから出した予想は自動的に成績から外れるので、後から良い版を選ぶことはできない。
 *
 * 予測の中身は data/private/ に置き、GitHubには上げない（.gitignore 済み）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_DIR = path.join(ROOT, 'data', 'private');
const RECORD = path.join(ROOT, 'data', 'record.json');
// 買い目の条件：AI勝率1位 かつ 期待値1.2以上（2026-10-24 以降。それ以前は1.3以上）の馬の単勝
const EV_MIN = 1.2;            // 期待値の下限
const AI_RANK = 1;             // AI勝率順位（1位のみ）
const STAKE = 100;             // 1点あたりの購入額（円）

const jstDate = () => new Date(Date.now() + 9 * 3600 * 1000);
const jstStamp = () => jstDate().toISOString().replace('T', ' ').slice(0, 19) + ' JST';
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
// TARGETの着順は全角数字（１〜９）で入ることがあるので半角に直してから読む
const toHalf = (v) => String(v ?? '').replace(/[０-９．：]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const num = (v) => { const n = parseFloat(toHalf(v).replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const pct = (v) => { const n = num(v); return n === null ? null : n / 100; };
/** "15:45" → 945（その日の0時からの分数）。取れなければ null */
const toMinutes = (v) => {
  const m = toHalf(v).match(/(\d{1,2})\s*[:時]\s*(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
/**
 * 障害競走かどうか。平地用のモデルなので買い目から外す。
 * JRAの平地は最長3600mで、距離はほぼすべて100mの倍数（例外は福島ダート1150m）。
 * 障害は3210・3350・3570mのような半端な距離か、3600m超になる（3300m・2900mも障害だけにある）。
 * 距離が取れない古い記録のために、レース名でも判定する（ジャパンＣを巻き込まないよう「ジャパ」は除く）。
 */
function isJumpRace(p) {
  const d = num(p.dist);
  if (d !== null) {
    if ((d % 100 !== 0 && d !== 1150) || d > 3600 || d === 3300 || d === 2900) return true;   // 福島ダート1150mだけは平地の半端な距離
  }
  const name = String(p.raceName || '') + String(p.cls || '');
  return /障害|ハードル|ジャンプ|ジャ(?!パ)/.test(name);
}
/** その点を成績から外す理由（障害競走、または手動の除外リスト）。対象外でなければ null */
function excludedReason(rec, date, p) {
  if (isJumpRace(p)) return '障害競走';
  const hit = (rec.excluded || []).find((e) => e.date === date && e.place === p.place && String(e.race) === String(p.race));
  return hit ? hit.reason : null;
}
const loadRecord = () => (fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : { format: 'habu-ai/track/2', days: [] });
const saveRecord = (r) => { fs.mkdirSync(path.dirname(RECORD), { recursive: true }); fs.writeFileSync(RECORD, JSON.stringify(r, null, 2)); };

function readCsv(file) {
  const buf = fs.readFileSync(file);
  let s = buf.toString('utf8');
  if (s.includes('�')) s = new TextDecoder('shift_jis').decode(buf);   // TARGETのCSVはShift_JIS
  s = s.replace(/^﻿/, '');
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  const split = (line) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const header = split(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = split(l), row = {};
    header.forEach((h, i) => { if (row[h] === undefined || row[h] === '') row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
}

/** 予測CSV → その日の推奨馬（EV下限以上）を取り出す。障害競走は平地用モデルの対象外なので除く */
function extractPicks(rows) {
  const picks = [];
  const jumps = [];
  for (const r of rows) {
    const ev = num(r['期待値(EV)']);
    const rank = num(r['AI勝率順位']);
    if (ev === null || ev < EV_MIN) continue;
    if (rank !== AI_RANK) continue;              // AI勝率1位の馬だけを買う
    const p = {
      date: r['日付'], place: r['場所'], race: r['Ｒ'] || r['R'], raceName: r['レース名'],
      cls: r['クラス名'] || '', dist: r['距離'] || '', postTime: r['発走時刻'] || null,
      number: num(r['馬番']), name: (r['馬名'] || '').replace(/^\*/, '').trim(),
      winProb: pct(r['予測勝率']), ev, oddsAtPredict: num(r['単勝オッズ']),
      aiRank: num(r['AI勝率順位']), mark: r['推奨買い目'] || '',
    };
    if (isJumpRace(p)) { jumps.push(p); continue; }
    picks.push(p);
  }
  picks.sort((a, b) => String(a.place).localeCompare(String(b.place), 'ja') || (a.race - b.race) || (b.ev - a.ev));
  return { picks, jumps };
}

/**
 * 「--skip 中山5R」「--skip 中山5R-7」「--skip 中山5R:理由」のような指定を読む。
 * レース前に自分の判断で見送る点を、指紋に含めた形で記録するためのもの。
 */
function parseSkips(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--skip') continue;
    const spec = args[++i];
    if (!spec) continue;
    const [target, ...why] = spec.split(':');
    const m = toHalf(target).match(/^(.+?)\s*(\d{1,2})\s*R?(?:\s*[-‐ｰ]\s*(\d{1,2}))?$/);
    if (!m) throw new Error(`--skip の書き方が違います: ${spec}（例: --skip 中山5R、--skip 中山5R-7:距離が長い）`);
    out.push({ place: m[1].trim(), race: m[2], number: m[3] ? Number(m[3]) : null, reason: why.join(':').trim() || '羽生の判断で見送り' });
  }
  return out;
}

/** 「--add 京都7R」「--add 福島8R:理由」を読む（書き方は --skip と同じ。番号は付けない） */
function parseAdds(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--add') continue;
    const spec = args[++i];
    if (!spec) continue;
    const [target, ...why] = spec.split(':');
    const m = toHalf(target).match(/^(.+?)\s*(\d{1,2})\s*R?$/);
    if (!m) throw new Error(`--add の書き方が違います: ${spec}（例: --add 京都7R、--add 福島8R:理由）`);
    out.push({ place: m[1].trim(), race: m[2], reason: why.join(':').trim() || '羽生の判断で追加' });
  }
  return out;
}

function cmdCommit(csvPath, args = []) {
  const rows = readCsv(csvPath);
  const { picks, jumps } = extractPicks(rows);
  // 羽生の判断で、別のCSV（ダートなど）から買い足す点。AIの記録には入れず、added の印を付けて指紋に含める
  const adds = parseAdds(args);
  const addCsvIdx = args.indexOf('--add-csv');
  if (adds.length) {
    if (addCsvIdx < 0 || !args[addCsvIdx + 1]) throw new Error('--add を使うときは --add-csv <別の予測CSV> も指定してください');
    const { picks: extra } = extractPicks(readCsv(args[addCsvIdx + 1]));
    for (const a of adds) {
      const hit = extra.filter((p) => p.place === a.place && String(p.race) === String(a.race));
      if (!hit.length) throw new Error(`--add ${a.place}${a.race}R に当たる買い目が、追加用のCSVにありません（買い目: ${extra.map((p) => p.place + p.race + 'R').join(' / ') || 'なし'}）`);
      if (picks.some((p) => p.place === a.place && String(p.race) === String(a.race))) throw new Error(`--add ${a.place}${a.race}R は、すでにAIの買い目にあります`);
      hit.forEach((p) => { p.added = a.reason; picks.push(p); });
    }
    picks.sort((a, b) => String(a.place).localeCompare(String(b.place), 'ja') || (a.race - b.race) || (b.ev - a.ev));
  }
  // レース前に決めた「見送り」を、買い目そのものと一緒に指紋へ含める
  const skips = parseSkips(args);
  for (const s of skips) {
    const hit = picks.filter((p) => p.place === s.place && String(p.race) === String(s.race) && (s.number === null || p.number === s.number));
    if (!hit.length) throw new Error(`--skip ${s.place}${s.race}R に当たる買い目がありません（買い目: ${picks.map((p) => p.place + p.race + 'R').join(' / ') || 'なし'}）`);
    hit.forEach((p) => { p.skip = s.reason; });
  }
  // 買い目が0点の版も記録できる（その時点で買い目が無い、または前の版の買い目が基準割れで外れた、という記録になる）。
  // ただし、オッズが入っていないCSVで0点になったときは、間違いなので止める（期待値が数字で入っている行が半分未満）。
  if (!picks.length) {
    const withEv = rows.filter((r) => num(r['期待値(EV)']) !== null).length;
    if (!rows.length || withEv < rows.length * 0.5) throw new Error(`買い目が0点ですが、期待値が入っている行が少なすぎます（${withEv}/${rows.length}行）。オッズが入っていないCSVの可能性があります`);
  }
  const date = picks.length ? picks[0].date : (rows.find((r) => r['日付']) || {})['日付'];
  if (!date) throw new Error('予測CSVに「日付」の列がありません');
  const key = date.replace(/\./g, '-');
  const now = jstDate();
  const body = JSON.stringify({ date, evMin: EV_MIN, picks });
  const hash = sha256(body);

  const rec = loadRecord();
  let day = rec.days.find((d) => d.date === key);
  if (!day) { day = { date: key, versions: [], result: null }; rec.days.push(day); rec.days.sort((a, b) => a.date.localeCompare(b.date)); }
  if (day.versions.some((v) => v.hash === hash)) { console.log('前回と同じ内容だったので、記録しませんでした'); return; }

  const v = day.versions.length + 1;
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(PRIVATE_DIR, `${key}_v${v}.json`), body);
  day.versions.push({
    v, committedAt: jstStamp(), committedMin: now.getUTCHours() * 60 + now.getUTCMinutes(),
    hash, evMin: EV_MIN, pickCount: picks.length, revealed: false, picks: null,
  });
  saveRecord(rec);

  const noPost = picks.filter((p) => !p.postTime).length;
  console.log(`${key} 第${v}版: ${picks.length ? `推奨 ${picks.length} 点` : '買い目なし（0点）'}の指紋を記録しました（${jstStamp()}）`);
  console.log(`  ハッシュ: ${hash}`);
  console.log(`  内訳: ${picks.map((p) => `${p.place}${p.race}R ${p.number}番${p.skip ? '【見送り】' : ''}${p.added ? '【羽生が買い足し】' : ''}${p.postTime ? `(${p.postTime}発走)` : ''}`).join(' / ')}`);
  if (skips.length) console.log(`  ※ 羽生の判断で見送り ${picks.filter((p) => p.skip).length} 点（${picks.filter((p) => p.skip).map((p) => `${p.place}${p.race}R ${p.number}番: ${p.skip}`).join(' / ')}）`);
  if (jumps.length) console.log(`  ※ 障害競走 ${jumps.length} 件を除きました（${jumps.map((p) => `${p.place}${p.race}R ${p.raceName}`).join(' / ')}）`);
  if (noPost) console.log(`  ※ 発走時刻の列が無い点が ${noPost} 件あります（結果CSVの発走時刻で判定するので、このままで問題ありません）`);
  console.log('  → git add -A && git commit && git push で、この時刻が公開記録に残ります（中身はまだ出ません）');
}

function cmdReveal(dateArg) {
  const key = String(dateArg).replace(/[./]/g, '-');
  const rec = loadRecord();
  const day = rec.days.find((d) => d.date === key);
  if (!day) throw new Error(`${key} の記録がありません。先に commit してください`);
  let n = 0;
  for (const v of day.versions) {
    const file = path.join(PRIVATE_DIR, `${key}_v${v.v}.json`);
    if (!fs.existsSync(file)) { console.log(`  ! 第${v.v}版のファイルがありません: ${file}`); continue; }
    const body = fs.readFileSync(file, 'utf8');
    if (sha256(body) !== v.hash) throw new Error(`第${v.v}版の指紋が一致しません（ファイルが書き換わっています）`);
    v.picks = JSON.parse(body).picks;
    v.revealed = true;
    v.revealedAt = jstStamp();
    n++;
  }
  saveRecord(rec);
  console.log(`${key}: ${n}版を公開しました（指紋はすべて一致）`);
}

/**
 * 成績に数える点を選ぶ。
 * 各レースについて「発走時刻より前に記録された最後の版」を採用する。
 * 発走時刻が不明な場合は、その日の最後の版を使う（記録には unknownPostTime として残す）。
 */
function selectOfficialPicks(day, postTimes = new Map()) {
  // 各版は「その時点のその日の買い目の全部」。レースごとに採用する版を1つ決め、そのレースの買い目は採用版のものだけを使う。
  // 後の版で消えた買い目（そのレースに買い目が無くなった）は、前の版にあっても数えない。
  const versions = day.versions.filter((v) => v.picks);
  const lastV = Math.max(...day.versions.map((v) => v.v));
  const races = new Map();   // "場所|R" → 発走時刻（どの版にも買い目があったレース）
  for (const v of versions) {
    for (const p of v.picks) {
      // 発走時刻は予測CSVの列か、結果CSV（TARGET）から取る。公開済みの予測そのものは書き換えない
      const postTime = p.postTime || postTimes.get(`${p.place}|${p.race}`) || null;
      const key = `${p.place}|${p.race}`;
      if (!races.has(key) || (!races.get(key) && postTime)) races.set(key, postTime);
    }
  }
  const picks = [];
  let unknownPostTime = 0;
  for (const [key, postTime] of races) {
    const post = toMinutes(postTime);
    let adopted;
    if (post === null) { adopted = versions.find((v) => v.v === lastV); }   // 発走時刻が不明：その日の最後の版
    else {
      const before = versions.filter((v) => v.committedMin == null || v.committedMin < post);   // 発走後に出した版は数えない
      adopted = before.length ? before.reduce((a, b) => (b.v > a.v ? b : a)) : null;
    }
    if (!adopted) continue;
    for (const p of adopted.picks) {
      if (`${p.place}|${p.race}` !== key) continue;
      if (post === null) unknownPostTime++;
      picks.push({ ...p, postTime, fromVersion: adopted.v });
    }
  }
  return { picks, unknownPostTime };
}

/** 新馬・未勝利を除いたものが「1勝クラス以上」 */
const isAdvanced = (p) => !/新馬|未勝利/.test(String(p.cls || p.raceName || ''));
/** 買った点の集計（着順が取れた点だけを数える） */
function tally(picks) {
  const done = picks.filter((p) => p.finish != null);
  if (!done.length) return null;
  const hits = done.filter((p) => p.finish === 1);
  const top3 = done.filter((p) => p.finish <= 3);          // 買ったのは単勝だが、どれだけ惜しかったかの目安
  const ret = hits.reduce((a, p) => a + (p.payout ?? 0), 0);
  const stake = done.length * STAKE;
  return {
    bets: done.length, hits: hits.length, hitRate: hits.length / done.length,
    top3: top3.length, top3Rate: top3.length / done.length,
    stake, ret, roi: ret / stake,
  };
}

function cmdResults(csvPath) {
  const rows = readCsv(csvPath);
  const col = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== '') return r[n]; return ''; };
  const table = new Map();
  const postTimes = new Map();   // "日付|場所|R" → 発走時刻（結果CSVから拾う）
  for (const r of rows) {
    // 日付は「日付」列か、TARGETの「レースID(新)」の先頭8桁（例: 20260920…）から取る
    let date = String(col(r, '日付', '日付(yyyy.mm.dd)')).replace(/\./g, '-');
    if (!date) {
      const id = String(col(r, 'レースID(新)', 'レースID'));
      if (/^\d{8}/.test(id)) date = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
    }
    const post = col(r, '発走時刻', '発走');
    if (post) postTimes.set([date, col(r, '場所'), num(col(r, 'Ｒ', 'R'))].join('|'), post);
    const key = [date, col(r, '場所'), num(col(r, 'Ｒ', 'R')), num(col(r, '馬番', '馬番号'))].join('|');
    table.set(key, {
      finish: num(col(r, '確定着順', '着順', '着')),
      payout: num(col(r, '単勝払戻', '単勝配当', '払戻', '単勝')),
      finalOdds: num(col(r, '単勝オッズ', '単オッズ')),
    });
  }

  // 結果CSVに入っている日付だけを更新する。
  // 全部の日を作り直すと、1日分のCSVを入れたときに他の日の成績が消えてしまう
  const datesInCsv = new Set([...table.keys()].map((k) => k.split('|')[0]));

  const rec = loadRecord();
  let matched = 0, missing = 0, kept = 0;
  for (const day of rec.days) {
    if (!day.versions.some((v) => v.revealed)) continue;
    if (!datesInCsv.has(day.date)) { if (day.result) kept++; continue; }
    const dayPost = new Map();
    for (const [k, v] of postTimes) { const [d, place, race] = k.split('|'); if (d === day.date) dayPost.set(`${place}|${race}`, v); }
    const { picks, unknownPostTime } = selectOfficialPicks(day, dayPost);
    // 障害競走など対象外の点は、記録には理由つきで残したまま集計から外す
    for (const p of picks) { const why = excludedReason(rec, day.date, p); if (why) p.excluded = why; }
    let unknown = 0;
    for (const p of picks) {
      if (p.excluded) continue;
      const r = table.get([day.date, p.place, p.race, p.number].join('|'));
      if (!r || r.finish === null) { unknown++; p.finish = null; missing++; continue; }
      p.finish = r.finish;
      const payout = r.payout !== null ? r.payout : r.finalOdds !== null ? r.finalOdds * STAKE : null;
      p.payout = r.finish === 1 ? payout : 0;
      matched++;
    }
    const counted = picks.filter((p) => !p.excluded && !p.added);   // AI通り（ルール通りに全部買った場合）。羽生の買い足しは含めない
    const added = picks.filter((p) => !p.excluded && p.added);      // 羽生の判断でレース前に買い足した点（AIの記録には入れない）
    const keptPicks = counted.filter((p) => !p.skip);
    const mine = keptPicks.concat(added);                           // AI＋羽生の判断（見送った点を除き、買い足した点を加える）
    day.official = { picks, unknownPostTime };
    day.result = {
      all: tally(counted), adv: tally(counted.filter(isAdvanced)),
      myAll: tally(mine), myAdv: tally(mine.filter(isAdvanced)),
      skipped: counted.length - keptPicks.length, added: added.length, unknown,
    };
  }

  const skipped = rebuildSummary(rec);
  saveRecord(rec);

  console.log(`結果を取り込みました: ${matched}点 一致 / ${missing}点 見つからず`
    + (kept ? ` （このCSVに無い ${kept}日分は、前回の集計をそのまま残しました）` : ''));
  printSummary(rec, skipped);
}

/** 保存済みの着順から、日ごとの集計と通算を作り直す（集計の定義を変えたときに使う） */
function rebuildDays(rec) {
  for (const day of rec.days) {
    if (!day.official || !day.official.picks) continue;
    const picks = day.official.picks;
    for (const p of picks) { const why = excludedReason(rec, day.date, p); if (why) p.excluded = why; else delete p.excluded; }
    const counted = picks.filter((p) => !p.excluded && !p.added);
    const added = picks.filter((p) => !p.excluded && p.added);
    const kept = counted.filter((p) => !p.skip);
    const mine = kept.concat(added);
    day.result = {
      all: tally(counted), adv: tally(counted.filter(isAdvanced)),
      myAll: tally(mine), myAdv: tally(mine.filter(isAdvanced)),
      skipped: counted.length - kept.length, added: added.length,
      unknown: picks.filter((p) => !p.excluded && p.finish == null).length,
    };
  }
}

function rebuildSummary(rec) {
  const sum = (key) => {
    const done = rec.days.filter((d) => d.result && d.result[key]);
    const t = done.reduce((a, d) => ({
      bets: a.bets + d.result[key].bets, hits: a.hits + d.result[key].hits,
      top3: a.top3 + (d.result[key].top3 || 0),
      stake: a.stake + d.result[key].stake, ret: a.ret + d.result[key].ret,
    }), { bets: 0, hits: 0, top3: 0, stake: 0, ret: 0 });
    return t.bets
      ? { days: done.length, ...t, hitRate: t.hits / t.bets, top3Rate: t.top3 / t.bets, roi: t.ret / t.stake }
      : null;
  };
  const skipped = rec.days.reduce((a, d) => a + ((d.result && d.result.skipped) || 0), 0);
  const added = rec.days.reduce((a, d) => a + ((d.result && d.result.added) || 0), 0);
  rec.summary = {
    all: sum('all'), adv: sum('adv'), myAll: sum('myAll'), myAdv: sum('myAdv'),
    skipped, added, evMin: EV_MIN, aiRank: AI_RANK, stakePerBet: STAKE, updatedAt: jstStamp(),
  };
  return skipped;
}

function cmdRecalc() {
  const rec = loadRecord();
  rebuildDays(rec);
  const skipped = rebuildSummary(rec);
  saveRecord(rec);
  console.log('保存済みの着順から集計を作り直しました（結果CSVは不要）');
  printSummary(rec, skipped);
}

function printSummary(rec, skipped) {
  const rows2 = [['all', 'AIのみ   全クラス    '], ['adv', 'AIのみ   1勝クラス以上']];
  if (skipped || (rec.summary.added || 0)) rows2.push(['myAll', 'AI＋羽生 全クラス    ']);
  for (const [key, label] of rows2) {
    const s = rec.summary[key];
    if (s) console.log(`  ${label} 通算 ${s.days}日 ${s.bets}点  的中 ${s.hits}点 (${(s.hitRate * 100).toFixed(1)}%)`
      + `  3着内 ${s.top3}点 (${(s.top3Rate * 100).toFixed(1)}%)  回収率 ${(s.roi * 100).toFixed(1)}%`);
  }
  if (skipped) console.log(`  （レース前に羽生が見送った点: 通算 ${skipped} 点）`);
  if (rec.summary.added) console.log(`  （レース前に羽生が買い足した点: 通算 ${rec.summary.added} 点。AIのみには数えない）`);
}

/** 特定のレースを成績の対象外にする（理由は公開ページに表示される） */
function cmdExclude(dateArg, place, race, reason) {
  if (!dateArg || !place || !race) throw new Error('使い方: node tools/track.mjs exclude <日付> <場所> <R> [理由]');
  const date = String(dateArg).replace(/[./]/g, '-');
  const rec = loadRecord();
  rec.excluded = rec.excluded || [];
  const why = reason || '対象外';
  const i = rec.excluded.findIndex((e) => e.date === date && e.place === place && String(e.race) === String(race));
  if (i >= 0) rec.excluded[i].reason = why;
  else rec.excluded.push({ date, place, race: String(race), reason: why });
  saveRecord(rec);
  console.log(`${date} ${place}${race}R を成績の対象外にしました（理由: ${why}）`);
  console.log('  → results を実行し直すと集計に反映されます（買い目の記録自体は理由つきで残ります）');
}

function cmdVerify() {
  const rec = loadRecord();
  let ok = 0, ng = 0, wait = 0;
  for (const day of rec.days) {
    for (const v of day.versions) {
      if (!v.revealed || !v.picks) { wait++; continue; }
      const body = JSON.stringify({ date: day.date.replace(/-/g, '.'), evMin: v.evMin ?? EV_MIN, picks: v.picks.map(({ finish, payout, fromVersion, ...p }) => p) });
      if (sha256(body) === v.hash) ok++;
      else { ng++; console.log(`  × ${day.date} 第${v.v}版: 指紋が一致しません`); }
    }
  }
  console.log(`指紋の照合: 一致 ${ok}版 / 不一致 ${ng}版 / 未公開 ${wait}版`);
  if (ng) process.exitCode = 1;
}

/* ===== 世界線ログ（重賞のみ） =====
 * シミュレーターの公開データ（race_public.dat）には、レースごとに世界線（抽選済みの着順）が入っている。
 * レース後に、実際の1〜3着と同じ並びの世界線を探して記録する。無ければ No.0（worlds が空）。
 * 公開データは data/worlds/ に控えを残し、ハッシュも記録する（GitHubの履歴で、いつ公開したかが確認できる）。 */
const WORLD_DIR = path.join(ROOT, 'data', 'worlds');
function decodeDat(text) {
  const key = Buffer.from('habu-ai-sim');
  const b = Buffer.from(text.trim(), 'base64');
  return JSON.parse(Buffer.from(b.map((x, i) => x ^ key[i % key.length])).toString('utf8'));
}
const gradeOf = (...xs) => { const m = toHalf(xs.join(' ')).replace(/Ｇ/g, 'G').match(/G([123])/); return m ? 'G' + m[1] : null; };
const parseOrders = (R) => (R.orders || []).map((o) => (typeof o === 'string' ? [...o].map((c) => parseInt(c, 36)) : o.map(Number)));
const normDate = (v) => { const m = toHalf(v).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };

function cmdWorldlog(csvPath, rest) {
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
  const datFile = path.resolve(flag('--dat') || path.join(ROOT, 'race_public.dat'));
  const nameOverride = flag('--name');
  const datText = fs.readFileSync(datFile, 'utf8');
  const dat = decodeDat(datText);
  const datHash = sha256(datText.trim());

  const rows = readCsv(csvPath);
  const col = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== '') return r[n]; return ''; };
  const finish = new Map(), post = new Map();
  for (const r of rows) {
    let date = String(col(r, '日付', '日付(yyyy.mm.dd)')).replace(/\./g, '-');
    if (!date) { const id = String(col(r, 'レースID(新)', 'レースID')); if (/^\d{8}/.test(id)) date = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`; }
    const rk = [date, col(r, '場所'), num(col(r, 'Ｒ', 'R'))].join('|');
    const t = col(r, '発走時刻', '発走'); if (t) post.set(rk, t);
    const fin = num(col(r, '確定着順', '着順', '着'));
    if (fin !== null) finish.set(rk + '|' + fin, num(col(r, '馬番', '馬番号')));
  }

  const rec = loadRecord();
  rec.worldlog = rec.worldlog || [];
  const graded = (dat.races || []).filter((R) => gradeOf(R.cls, R.name));
  if (!graded.length) { console.log('公開データに重賞のレースがありません'); return; }
  let archived = false;
  for (const R of graded) {
    const date = R.date.replace(/\./g, '-');
    const rk = [date, R.place, num(R.r)].join('|');
    const top = [1, 2, 3].map((k) => finish.get(rk + '|' + k));
    if (top.some((v) => v == null)) { console.log(`  × ${date} ${R.place}${R.r}R: 結果CSVに1〜3着が見つかりません`); continue; }
    const hs = Object.fromEntries(R.horses.map((h) => [Number(h.number), h]));
    const orders = parseOrders(R);
    const worlds = [];
    orders.forEach((o, i) => { if (top.every((n, k) => o[k] === n)) worlds.push(i + 1); });
    const grade = gradeOf(R.cls, R.name);
    const baseName = String(R.name).replace(/[ＧG][1-3１-３]\s*$/, '').replace(/\*/g, '').trim();
    // 作成時刻が発走より後なら、レース後に作った世界線として印を付ける
    const pt = toMinutes(post.get(rk));
    const created = new Date(dat.created);
    const jst = new Date(created.getTime() + 9 * 3600 * 1000);
    const createdMin = jst.getUTCHours() * 60 + jst.getUTCMinutes();
    const createdDate = jst.toISOString().slice(0, 10);
    const postRace = pt == null ? null : (createdDate > date || (createdDate === date && createdMin > pt));
    const entry = {
      date, place: R.place, race: num(R.r), raceName: (graded.length === 1 && nameOverride) || baseName, grade, dist: R.dist,
      top3: top.map((n) => ({ number: n, name: hs[n] ? hs[n].name : '', waku: hs[n] ? hs[n].waku : null })),
      worlds, worldCount: orders.length, payout3t: null,
      createdAt: dat.created, postRace, datHash,
    };
    if (!archived) {
      fs.mkdirSync(WORLD_DIR, { recursive: true });
      fs.writeFileSync(path.join(WORLD_DIR, `${date}_${datHash.slice(0, 8)}.dat`), datText);
      archived = true;
    }
    entry.datFile = `data/worlds/${date}_${datHash.slice(0, 8)}.dat`;
    const old = rec.worldlog.findIndex((e) => e.date === entry.date && e.place === entry.place && e.race === entry.race);
    if (old >= 0) { entry.payout3t = rec.worldlog[old].payout3t ?? null; rec.worldlog[old] = entry; } else rec.worldlog.push(entry);
    const wtxt = worlds.length ? worlds.map((w) => 'No.' + w).join('・') : 'No.0（' + orders.length + '通りのどこにも無し）';
    console.log(`  ○ ${date} ${R.place}${R.r}R ${entry.raceName}（${grade}）: ${top.join('→')} / 世界線 ${wtxt}${postRace ? '　※レース後に作成した世界線' : ''}`);
  }
  rec.worldlog.sort((a, b) => a.date.localeCompare(b.date) || a.place.localeCompare(b.place, 'ja') || a.race - b.race);
  saveRecord(rec);
}

function cmdWorldlogPayout(csvPath) {
  const rec = loadRecord();
  const todo = (rec.worldlog || []).filter((e) => e.payout3t == null);
  if (!todo.length) { console.log('3連単配当が空白の世界線ログはありません'); return; }
  const pay = new Map();
  for (const r of readCsv(csvPath)) {
    const v = num(r['３連単'] ?? r['3連単']);
    if (v === null || v <= 0) continue;
    pay.set([normDate(r['日付(yyyy.mm.dd)'] ?? r['日付']), r['場所'], num(r['Ｒ'] ?? r['R'])].join('|'), v);
  }
  let filled = 0;
  for (const e of todo) {
    const v = pay.get([e.date, e.place, e.race].join('|'));
    if (v != null) { e.payout3t = v; filled++; console.log(`  ○ ${e.date} ${e.place}${e.race}R ${e.raceName}: 3連単 ${v.toLocaleString()}円`); }
    else console.log(`  － ${e.date} ${e.place}${e.race}R ${e.raceName}: このCSVには3連単配当がありません（空白のまま）`);
  }
  saveRecord(rec);
  console.log(`3連単配当を ${filled}件 埋めました`);
}

const [cmd, arg, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'commit') cmdCommit(arg, rest);
  else if (cmd === 'reveal') cmdReveal(arg);
  else if (cmd === 'results') cmdResults(arg);
  else if (cmd === 'recalc') cmdRecalc();
  else if (cmd === 'exclude') cmdExclude(arg, rest[0], rest[1], rest.slice(2).join(' '));
  else if (cmd === 'verify') cmdVerify();
  else if (cmd === 'worldlog') cmdWorldlog(arg, rest);
  else if (cmd === 'worldlog-payout') cmdWorldlogPayout(arg);
  else {
    console.log('使い方:');
    console.log('  node tools/track.mjs commit "<予測CSV>" [--skip 中山5R[-7][:理由]]');
    console.log('                                            レース前：指紋だけ記録（1日に何度でも）');
    console.log('                                            --skip はレース前に羽生が見送る点（理由も書ける）。指紋に含めて記録する');
    console.log('  node tools/track.mjs reveal <日付>         レース後：中身を公開');
    console.log('  node tools/track.mjs results "<結果CSV>"   結果を取り込んで集計');
    console.log('  node tools/track.mjs exclude <日付> <場所> <R> [理由]   そのレースを成績の対象外にする');
    console.log('  node tools/track.mjs recalc                保存済みの着順から集計を作り直す');
    console.log('  node tools/track.mjs verify                指紋の照合');
    console.log('  node tools/track.mjs worldlog "<結果CSV>" [--dat <datファイル>] [--name "<表示名>"]');
    console.log('                                            重賞：実際の1〜3着が世界線の中にあったかを記録');
    console.log('  node tools/track.mjs worldlog-payout "<全データCSV>"   世界線ログの3連単配当を埋める');
  }
} catch (e) {
  console.error('エラー:', e.message);
  process.exitCode = 1;
}
