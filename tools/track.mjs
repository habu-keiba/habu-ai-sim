/**
 * 羽生AI 実績記録ツール
 *
 *   node tools/track.mjs commit "<予測CSV>"     レース前：予測の指紋(ハッシュ)だけを公開用に記録する
 *   node tools/track.mjs reveal <日付>          レース後：予測の中身を公開する（指紋と一致することを確認できる）
 *   node tools/track.mjs results "<結果CSV>"    結果を取り込み、的中率と回収率を集計する
 *   node tools/track.mjs verify                 公開済みの予測が、記録した指紋と一致するか確かめる
 *
 * 予測の中身は data/private/ に置き、GitHubには上げない（.gitignore 済み）。
 * 公開されるのは data/record.json だけで、レース前は指紋のみ、レース後に中身が入る。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_DIR = path.join(ROOT, 'data', 'private');
const RECORD = path.join(ROOT, 'data', 'record.json');
const EV_MIN = 1.3;            // 推奨とみなす期待値の下限
const STAKE = 100;             // 1点あたりの購入額（円）

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' JST';
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function readCsv(file) {
  let text = fs.readFileSync(file);
  // BOM付きUTF-8 / cp932 のどちらでも読めるようにする
  let s = text.toString('utf8');
  if (s.includes('�')) s = new TextDecoder('shift_jis').decode(text);
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
    header.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return row;
  });
}

// TARGETの着順は全角数字（１〜９）で入ることがあるので半角に直してから読む
const toHalf = (v) => String(v ?? '').replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const num = (v) => { const n = parseFloat(toHalf(v).replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const pct = (v) => { const n = num(v); return n === null ? null : n / 100; };
const loadRecord = () => (fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : { format: 'habu-ai/track/1', days: [] });
const saveRecord = (r) => { fs.mkdirSync(path.dirname(RECORD), { recursive: true }); fs.writeFileSync(RECORD, JSON.stringify(r, null, 2)); };

/** 予測CSV → その日の推奨馬（EV1.3以上）を取り出す */
function extractPicks(rows) {
  const picks = [];
  for (const r of rows) {
    const ev = num(r['期待値(EV)']);
    if (ev === null || ev < EV_MIN) continue;
    picks.push({
      date: r['日付'], place: r['場所'], race: r['Ｒ'] || r['R'], raceName: r['レース名'],
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
  if (!picks.length) throw new Error(`期待値${EV_MIN}以上の推奨馬が1頭もありません`);
  const date = picks[0].date;
  const payload = { date, evMin: EV_MIN, picks };
  const body = JSON.stringify(payload);
  const hash = sha256(body);

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(PRIVATE_DIR, `${date.replace(/\./g, '-')}.json`), body);

  const rec = loadRecord();
  const key = date.replace(/\./g, '-');
  if (rec.days.some((d) => d.date === key && d.revealed)) throw new Error(`${key} はすでに公開済みです`);
  rec.days = rec.days.filter((d) => d.date !== key);
  rec.days.push({ date: key, committedAt: jstNow(), hash, evMin: EV_MIN, pickCount: picks.length, revealed: false, picks: null, result: null });
  rec.days.sort((a, b) => a.date.localeCompare(b.date));
  saveRecord(rec);

  console.log(`${key}: 推奨 ${picks.length} 点の指紋を記録しました`);
  console.log(`  ハッシュ: ${hash}`);
  console.log(`  内訳: ${picks.map((p) => `${p.place}${p.race}R ${p.number}番`).join(' / ')}`);
  console.log('  → GitHubに送ると、この時刻で公開記録に残ります（中身はまだ出ません）');
}

function cmdReveal(date) {
  const key = String(date).replace(/[./]/g, '-');
  const file = path.join(PRIVATE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) throw new Error(`${file} がありません`);
  const body = fs.readFileSync(file, 'utf8');
  const rec = loadRecord();
  const day = rec.days.find((d) => d.date === key);
  if (!day) throw new Error(`${key} の記録がありません。先に commit してください`);
  if (sha256(body) !== day.hash) throw new Error('指紋が一致しません（予測ファイルが書き換わっています）');
  day.picks = JSON.parse(body).picks;
  day.revealed = true;
  day.revealedAt = jstNow();
  saveRecord(rec);
  console.log(`${key}: 推奨 ${day.picks.length} 点を公開しました（指紋は一致）`);
}

/** 結果CSV（日付・場所・Ｒ・馬番・着順・単勝払戻 を含むもの）を取り込んで集計する */
function cmdResults(csvPath) {
  const rows = readCsv(csvPath);
  const col = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== '') return r[n]; return ''; };
  const table = new Map();
  for (const r of rows) {
    // 日付は「日付」列か、TARGETの「レースID(新)」の先頭8桁（例: 20260920…）から取る
    let date = String(col(r, '日付', '日付(yyyy.mm.dd)')).replace(/\./g, '-');
    if (!date) {
      const id = String(col(r, 'レースID(新)', 'レースID'));
      if (/^\d{8}/.test(id)) date = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
    }
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
    if (!day.revealed || !day.picks) continue;
    let bets = 0, hits = 0, ret = 0, unknown = 0;
    for (const p of day.picks) {
      const key = [day.date, p.place, p.race, p.number].join('|');
      const r = table.get(key);
      if (!r || r.finish === null) { unknown++; p.finish = null; continue; }
      p.finish = r.finish;
      const payout = r.payout !== null ? r.payout : r.finalOdds !== null ? r.finalOdds * STAKE : null;
      p.payout = r.finish === 1 ? payout : 0;
      bets++; if (r.finish === 1) { hits++; ret += payout ?? 0; }
      matched++;
    }
    missing += unknown;
    day.result = bets ? { bets, hits, hitRate: hits / bets, stake: bets * STAKE, ret, roi: ret / (bets * STAKE), unknown } : null;
  }

  const done = rec.days.filter((d) => d.result);
  const total = done.reduce((a, d) => ({
    bets: a.bets + d.result.bets, hits: a.hits + d.result.hits,
    stake: a.stake + d.result.stake, ret: a.ret + d.result.ret,
  }), { bets: 0, hits: 0, stake: 0, ret: 0 });
  rec.summary = total.bets ? {
    days: done.length, bets: total.bets, hits: total.hits,
    hitRate: total.hits / total.bets, roi: total.ret / total.stake,
    stake: total.stake, ret: total.ret, evMin: EV_MIN, stakePerBet: STAKE, updatedAt: jstNow(),
  } : null;
  saveRecord(rec);

  console.log(`結果を取り込みました: ${matched}点 一致 / ${missing}点 見つからず`);
  if (rec.summary) {
    const s = rec.summary;
    console.log(`  通算 ${s.days}日 ${s.bets}点  的中 ${s.hits}点 (${(s.hitRate * 100).toFixed(1)}%)  回収率 ${(s.roi * 100).toFixed(1)}%`);
  }
}

function cmdVerify() {
  const rec = loadRecord();
  let ok = 0, ng = 0;
  for (const day of rec.days) {
    if (!day.revealed || !day.picks) continue;
    const body = JSON.stringify({ date: day.date.replace(/-/g, '.'), evMin: day.evMin ?? EV_MIN, picks: day.picks.map(({ finish, payout, ...p }) => p) });
    if (sha256(body) === day.hash) { ok++; } else { ng++; console.log(`  × ${day.date}: 指紋が一致しません`); }
  }
  console.log(`指紋の照合: 一致 ${ok}日 / 不一致 ${ng}日`);
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
    console.log('  node tools/track.mjs commit "<予測CSV>"    レース前：指紋だけ記録');
    console.log('  node tools/track.mjs reveal <日付>         レース後：中身を公開');
    console.log('  node tools/track.mjs results "<結果CSV>"   結果を取り込んで集計');
    console.log('  node tools/track.mjs verify                指紋の照合');
  }
} catch (e) {
  console.error('エラー:', e.message);
  process.exitCode = 1;
}
