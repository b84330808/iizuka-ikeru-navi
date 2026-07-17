// app.js の検索エンジンをヘッドレスで検証する
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

// ---- 最小限のDOMスタブ ----
const stubEl = () => new Proxy(function () {}, {
  get(t, p) {
    if (p === "classList") return { toggle() {}, add() {}, remove() {} };
    if (p === "style") return {};
    if (p === "dataset") return {};
    if (["addEventListener", "appendChild", "scrollIntoView"].includes(p)) return () => {};
    if (p === Symbol.toPrimitive || p === "toString") return () => "";
    return stubEl();
  },
  set() { return true; },
});
global.document = {
  querySelector: () => stubEl(),
  querySelectorAll: () => [],
  createElement: () => stubEl(),
  documentElement: stubEl(),
};
Object.defineProperty(global, "navigator", {
  value: { geolocation: { getCurrentPosition() {} } }, configurable: true,
});
global.window = { scrollTo() {} };

eval(readFileSync(path.join(app, "data.js"), "utf-8"));
global.APP_DATA = window.APP_DATA;
eval(readFileSync(path.join(app, "app.js"), "utf-8"));
const E = window.__engine;
const D = window.APP_DATA;

let fails = 0;
function check(label, cond, detail = "") {
  console.log((cond ? "PASS" : "FAIL") + "  " + label + (detail ? "  | " + detail : ""));
  if (!cond) fails++;
}
const stopIdx = (name, feed) => D.stops.findIndex(s => s.name === name && s.feed === feed);
const fmt = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const MON = new Date(2026, 6, 13); // 2026-07-13 月曜
const SUN = new Date(2026, 6, 12); // 日曜

// 1) カレンダー: 筑穂・高田線は平日のみ
check("chikuho 平日 active", E.serviceActive("chikuho", "平日", MON));
check("chikuho 日曜 inactive", !E.serviceActive("chikuho", "平日", SUN));
check("miyawaka 日曜 = 土日祝ダイヤ", E.serviceActive("miyawaka", "土曜・日曜・祝日", SUN));

// 2) 直行: 宮若線 吉原町 → 飯塚市役所方面(市役所停は宮若線に存在)
const yoshihara = D.stops.map((s, i) => [s, i]).filter(([s]) => s.feed === "miyawaka" && s.name.includes("吉原町"));
const shiyakusho = D.stops.map((s, i) => [s, i]).filter(([s]) => s.name === "飯塚市役所");
console.log("吉原町 poles:", yoshihara.map(([s, i]) => `${i}:${s.id}`).join(", "));
console.log("市役所 poles:", shiyakusho.map(([s, i]) => `${i}:${s.id} (${s.feed})`).join(", "));

const cityHall = { name: "飯塚市役所", lat: 33.64628, lon: 130.69135 };
let found = null;
for (const [, oi] of yoshihara) {
  const r = E.search(oi, cityHall, MON, 0);
  if (r.rides.length) { found = r; break; }
}
check("吉原町→市役所 直行あり(平日)", !!found && found.rides.length > 0);
if (found) for (const r of found.rides) {
  const legs = r.legs.map(l => `${D.stops[l.from].name}(${fmt(l.dep)})→${D.stops[l.to].name}(${fmt(l.arr)})`).join(" ⇒ ");
  console.log(`   ride: ${legs} fare=${r.fare}円 walk=${Math.ceil(r.walkM)}m`);
  check("運賃が取れる", r.fare !== null && r.fare > 0, `fare=${r.fare}`);
  check("時刻が単調", r.arr > r.dep);
}

// 3) 乗換: 筑穂・高田線の起点(内住あたり)→ 宮若線側の施設(鯰田/吉原町方面)
const chStops = D.stops.filter(s => s.feed === "chikuho");
console.log("chikuho sample stops:", chStops.slice(0, 5).map(s => s.name).join(", "));
const chFirst = stopIdx(chStops[0].name, "chikuho");
// 宮若線の吉原町バス停近くの架空施設
const yoshiharaStop = D.stops[yoshihara[0][1]];
const facNearYoshihara = { name: "吉原町近くの施設", lat: yoshiharaStop.lat, lon: yoshiharaStop.lon };
const tr = E.search(chFirst, facNearYoshihara, MON, 0);
console.log(`transfer search from ${chStops[0].name}: rides=${tr.rides.length}`);
for (const r of tr.rides) {
  const legs = r.legs.map(l => `${D.stops[l.from].name}(${fmt(l.dep)})→${D.stops[l.to].name}(${fmt(l.arr)})`).join(" ⇒ ");
  console.log(`   ride: ${legs} fare=${r.fare}円 legs=${r.legs.length}`);
  if (r.legs.length === 2) check("乗換時間>=3分", r.legs[1].dep - r.legs[0].arr >= 3, `${r.legs[0].arr}→${r.legs[1].dep}`);
}
check("hubs 前計算あり", E.hubs.length > 0, `hubs=${E.hubs.length}`);

// 4) 日曜: 筑穂・高田線エリアの施設(内住近く)へは日曜バスなし
const chStop0 = chStops[0];
const facNearChikuho = { name: "筑穂側施設", lat: chStop0.lat, lon: chStop0.lon };
const sunRes = E.search(yoshihara[0][1], facNearChikuho, SUN, 0);
check("日曜は筑穂側へ行けない(0件)", sunRes.rides.length === 0, `rides=${sunRes.rides.length}`);

// 5) バス停が近くにない施設 → reachable=false
const far = { name: "山奥", lat: 33.75, lon: 130.85 };
check("遠隔地は reachable=false", E.search(yoshihara[0][1], far, MON, 0).reachable === false);

// 5b) ignoreSvc: 日曜は筑穂側へ便が無い(gone)が、構造的には到達可能
const facNearCh2 = { name: "筑穂側施設", lat: chStop0.lat, lon: chStop0.lon };
const sunNormal = E.search(yoshihara[0][1], facNearCh2, SUN, 0, false);
const sunIgnore = E.search(yoshihara[0][1], facNearCh2, SUN, 0, true);
check("日曜は筑穂側へ運休(通常検索0件)", sunNormal.rides.length === 0);
check("構造的には到達可能(ignoreSvcで検出)= gone判定の根拠", sunIgnore.rides.length > 0,
      `ignore=${sunIgnore.rides.length}`);
// 本当に不通の遠隔地は ignoreSvc でも 0 = dead判定
check("遠隔地は ignoreSvc でも到達不可 = dead", E.search(yoshihara[0][1], far, MON, 0, true).rides.length === 0);

// 6) 全 trip の fare 整合性: 宮若線の任意区間で fare が引けるか
let missing = 0, checked = 0;
for (const t of D.trips.filter(t => t.feed === "miyawaka")) {
  const st = t.st;
  for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) {
    if (st[i][3] === 1 || st[j][4] === 1) continue; // pickup/dropoff不可
    checked++;
    if (E.fareFor(t, st[i][0], st[j][0]) == null) missing++;
  }
}
check("宮若線 全乗車区間の運賃網羅", missing === 0, `missing=${missing}/${checked}`);

// 7) エリアワゴン(穂波・菰田)統合
check("wagon feed が存在する", (D.wagonFeeds || []).includes("wagon_honami"));
check("wagon の便がある", D.trips.some(t => t.feed === "wagon_honami"));
const kinen = D.facilities.find(f => f.name.includes("飯塚記念病院"));
const chu = stopIdx("忠隈住民センター", "wagon_honami");
const wr = E.search(chu, kinen, MON, 0);
check("菰田→飯塚記念病院: ワゴンで到達可(月)", wr.rides.length > 0, `rides=${wr.rides.length}`);
check("最寄り停留所で降車(飯塚記念病院入口)",
      wr.rides.some(r => D.stops[r.alight].name === "飯塚記念病院入口"),
      wr.rides.map(r => D.stops[r.alight].name).join(","));
check("ワゴン運賃=100円", wr.rides.every(r => r.fare === 100));
check("日曜はワゴン全便運休", E.search(chu, kinen, SUN, 0).rides.length === 0);
const arriveByTen = E.searchArriveBy(chu, kinen, MON, 10 * 60, 0);
check("菰田→飯塚記念病院: 10時までに着く便を逆算できる",
      arriveByTen.rides.length > 0 && arriveByTen.rides.every(r => r.arr <= 10 * 60),
      arriveByTen.rides.map(r => `${fmt(r.dep)}→${fmt(r.arr)}`).join(","));

// 8) 予約交通コンシェルジュ
const judgeNow = new Date(2026, 6, 14, 9, 0);
const ready = E.evaluateConcierge({ district: "穂波", tripKind: "inside", registered: "yes", date: "2026-07-16", time: "10:00" }, judgeNow);
check("穂波・平日・登録済みは予約可能", ready.status === "ready" && ready.onlineBookable, ready.status);
const needsRegistration = E.evaluateConcierge({ district: "庄内", tripKind: "inside", registered: "no", date: "2026-07-16", time: "10:00" }, judgeNow);
check("未登録は登録案内", needsRegistration.status === "register", needsRegistration.status);
const unknownRegistration = E.evaluateConcierge({ district: "庄内", tripKind: "inside", registered: "unknown", date: "2026-07-16", time: "10:00" }, judgeNow);
check("登録状況不明は確認案内", unknownRegistration.status === "verify", unknownRegistration.status);
const tripActions = ["inside", "facility", "other", "center"].map(kind => E.tripPlan(kind).action);
check("行き先4区分は別々の次行動", new Set(tripActions).size === 4, tripActions.join(","));
const komoda = E.evaluateConcierge({ district: "菰田", tripKind: "inside", registered: "yes", date: "2026-07-16", time: "10:00" }, judgeNow);
check("菰田は予約タクシー対象外・ワゴン案内", komoda.status === "wagon" && komoda.wagon, komoda.status);
const weekendTaxi = E.evaluateConcierge({ district: "穂波", tripKind: "inside", registered: "yes", date: "2026-07-18", time: "10:00" }, judgeNow);
check("土曜は予約乗合タクシー運休", weekendTaxi.status === "closed", weekendTaxi.status);
const lunchBreak = E.evaluateConcierge({ district: "鎮西", tripKind: "inside", registered: "yes", date: "2026-07-16", time: "12:00" }, judgeNow);
check("鎮西12時は地区休憩時間", lunchBreak.status === "closed", lunchBreak.status);
const expiredTaxi = E.evaluateConcierge({ district: "穂波", tripKind: "inside", registered: "yes", date: "2026-07-14", time: "09:30" }, new Date(2026, 6, 14, 9, 1));
check("1時間前を過ぎた便は期限切れ", expiredTaxi.status === "expired", expiredTaxi.status);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
