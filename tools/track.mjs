/**
 * 羽生AI 実績記録ツール
 *
 *   node tools/track.mjs commit "<予測CSV>"     レース前：予測の指紋(ハッシュ)だけを記録する（1日に何度でも可）
 *   node tools/track.mjs reveal <日付>          レース後：その日の全ての版の中身を公開する
 *   node tools/track.mjs results "<結果CSV>"    結果を取り込み、的中率と回収率を集計する
 *   node tools/track.mjs verify                 公開済みの予測が、記録した指紋と一致するか確かめる
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
// 買い目の条件：AI勝率1位 かつ 期待値1.3以上の馬の単勝
const EV_MIN = 1.3;            // 期待値の下限
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

/** 予測CSV → その日の推奨馬（EV下限以上）を取り出す */
function extractPicks(rows) {
  const picks = [];
  for (const r of rows) {
    const ev = num(r['期待値(EV)']);
    const rank = num(r['AI勝率順位']);
    if (ev === null || ev < EV_MIN) continue;
    if (rank !== AI_RANK) continue;              // AI勝率1位の馬だけを買う
    picks.push({
      date: r['日付'], place: r['場所'], race: r['Ｒ'] || r['R'], raceName: r['レース名'],
      cls: r['クラス名'] || '', postTime: r['発走時刻'] || null,
      number: num(r['馬番']), name: (r['馬名'] || '').replace(/^\*/, '').trim(),
      winProb: pct(r['予測勝率']), ev, oddsAtPredict: num(r['単勝オッズ']),
      aiRank: num(r['AI勝率順位']), mark: r['推奨買い目'] || '',
    });
  }
  return picks.sort((a, b) => String(a.place).localeCompare(String(b.place), 'ja') || (a.race - b.race) || (b.ev - a.ev));
}

function cmdCommit(csvPath) {
  const rows = readCsv(csvPath);
  const picks = extractPicks(rows);
  if (!picks.length) throw new Error(`AI勝率1位かつ期待値${EV_MIN}以上の馬が1頭もありません（オッズが入っていないCSVの可能性があります）`);
  const date = picks[0].date;
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
  console.log(`${key} 第${v}版: 推奨 ${picks.length} 点の指紋を記録しました（${jstStamp()}）`);
  console.log(`  ハッシュ: ${hash}`);
  console.log(`  内訳: ${picks.map((p) => `${p.place}${p.race}R ${p.number}番${p.postTime ? `(${p.postTime}発走)` : ''}`).join(' / ')}`);
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
  const chosen = new Map();   // "場所|R|馬番" → {pick, v}
  let unknownPostTime = 0;
  const lastV = Math.max(...day.versions.map((v) => v.v));
  for (const v of day.versions) {
    if (!v.picks) continue;
    for (const p of v.picks) {
      // 発走時刻は予測CSVの列か、結果CSV（TARGET）から取る。公開済みの予測そのものは書き換えない
      const postTime = p.postTime || postTimes.get(`${p.place}|${p.race}`) || null;
      const post = toMinutes(postTime);
      if (post === null) { if (v.v !== lastV) continue; unknownPostTime++; }
      else if (v.committedMin != null && v.committedMin >= post) continue;   // 発走後に出した版は数えない
      chosen.set(`${p.place}|${p.race}|${p.number}`, { ...p, postTime, fromVersion: v.v });
    }
  }
  return { picks: [...chosen.values()], unknownPostTime };
}

/** 新馬・未勝利を除いたものが「1勝クラス以上」 */
const isAdvanced = (p) => !/新馬|未勝利/.test(String(p.cls || p.raceName || ''));
/** 買った点の集計（着順が取れた点だけを数える） */
function tally(picks) {
  const done = picks.filter((p) => p.finish != null);
  if (!done.length) return null;
  const hits = done.filter((p) => p.finish === 1);
  const ret = hits.reduce((a, p) => a + (p.payout ?? 0), 0);
  const stake = done.length * STAKE;
  return { bets: done.length, hits: hits.length, hitRate: hits.length / done.length, stake, ret, roi: ret / stake };
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

  const rec = loadRecord();
  let matched = 0, missing = 0;
  for (const day of rec.days) {
    if (!day.versions.some((v) => v.revealed)) continue;
    const dayPost = new Map();
    for (const [k, v] of postTimes) { const [d, place, race] = k.split('|'); if (d === day.date) dayPost.set(`${place}|${race}`, v); }
    const { picks, unknownPostTime } = selectOfficialPicks(day, dayPost);
    let unknown = 0;
    for (const p of picks) {
      const r = table.get([day.date, p.place, p.race, p.number].join('|'));
      if (!r || r.finish === null) { unknown++; p.finish = null; missing++; continue; }
      p.finish = r.finish;
      const payout = r.payout !== null ? r.payout : r.finalOdds !== null ? r.finalOdds * STAKE : null;
      p.payout = r.finish === 1 ? payout : 0;
      matched++;
    }
    day.official = { picks, unknownPostTime };
    day.result = { all: tally(picks), adv: tally(picks.filter(isAdvanced)), unknown };
  }

  const sum = (key) => {
    const done = rec.days.filter((d) => d.result && d.result[key]);
    const t = done.reduce((a, d) => ({
      bets: a.bets + d.result[key].bets, hits: a.hits + d.result[key].hits,
      stake: a.stake + d.result[key].stake, ret: a.ret + d.result[key].ret,
    }), { bets: 0, hits: 0, stake: 0, ret: 0 });
    return t.bets ? { days: done.length, ...t, hitRate: t.hits / t.bets, roi: t.ret / t.stake } : null;
  };
  rec.summary = { all: sum('all'), adv: sum('adv'), evMin: EV_MIN, aiRank: AI_RANK, stakePerBet: STAKE, updatedAt: jstStamp() };
  saveRecord(rec);

  console.log(`結果を取り込みました: ${matched}点 一致 / ${missing}点 見つからず`);
  for (const [key, label] of [['all', '全クラス    '], ['adv', '1勝クラス以上']]) {
    const s = rec.summary[key];
    if (s) console.log(`  ${label} 通算 ${s.days}日 ${s.bets}点  的中 ${s.hits}点 (${(s.hitRate * 100).toFixed(1)}%)  回収率 ${(s.roi * 100).toFixed(1)}%`);
  }
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

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'commit') cmdCommit(arg);
  else if (cmd === 'reveal') cmdReveal(arg);
  else if (cmd === 'results') cmdResults(arg);
  else if (cmd === 'verify') cmdVerify();
  else {
    console.log('使い方:');
    console.log('  node tools/track.mjs commit "<予測CSV>"    レース前：指紋だけ記録（1日に何度でも）');
    console.log('  node tools/track.mjs reveal <日付>         レース後：中身を公開');
    console.log('  node tools/track.mjs results "<結果CSV>"   結果を取り込んで集計');
    console.log('  node tools/track.mjs verify                指紋の照合');
  }
} catch (e) {
  console.error('エラー:', e.message);
  process.exitCode = 1;
}
