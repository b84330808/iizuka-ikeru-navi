/* いいづか のりものナビ — 検索エンジン + UI (vanilla JS) */
(function () {
  "use strict";
  const D = window.APP_DATA;
  const WALK_M_PER_MIN = 60;          // 高齢者の歩行速度目安
  const MAX_WALK_TO_STOP = 800;       // 下車バス停→目的地の許容距離(m)
  const TRANSFER_HUB_DIST = 250;      // 乗換とみなすバス停間距離(m)
  const MIN_TRANSFER_MIN = 3;

  // ---------- geo ----------
  const KY = 110540, KX = 111320 * Math.cos(33.64 * Math.PI / 180);
  function distM(aLat, aLon, bLat, bLon) {
    return Math.hypot((aLat - bLat) * KY, (aLon - bLon) * KX);
  }
  const walkMin = m => Math.max(1, Math.ceil(m / WALK_M_PER_MIN));

  // ---------- service calendar ----------
  function ymd(date) {
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate() + "";
  }
  function serviceActive(feed, serviceId, date) {
    const svc = D.services[feed][serviceId];
    if (!svc) return false;
    const s = ymd(date);
    if (svc.remove.includes(s)) return false;
    if (svc.add.includes(s)) return true;
    if (s < svc.start || s > svc.end) return false;
    const dow = (date.getDay() + 6) % 7; // Mon=0
    return svc.days[dow] === 1;
  }

  // ---------- fares ----------
  function fareFor(trip, fromIdx, toIdx) {
    const from = D.stops[fromIdx], to = D.stops[toIdx];
    if (trip.feed === "chikuho") return D.fares.chikuho_flat;
    const p = D.fares.miyawaka[from.zone + "|" + to.zone];
    return p === undefined ? null : p;
  }

  // ---------- search ----------
  // 直行便: origin と destStops のどれかを順に通る便
  function directRides(originIdx, destIdxs, date, afterMin) {
    const destSet = new Set(destIdxs);
    const rides = [];
    for (const trip of D.trips) {
      if (!serviceActive(trip.feed, trip.service, date)) continue;
      let boardAt = -1, boardDep = 0;
      for (const [si, arr, dep, pu, doff] of trip.st) {
        if (boardAt < 0) {
          if (si === originIdx && pu !== 1 && dep >= afterMin) { boardAt = si; boardDep = dep; }
        } else if (destSet.has(si) && doff !== 1) {
          rides.push({
            legs: [{ trip, from: originIdx, to: si, dep: boardDep, arr }],
            dep: boardDep, arr, alight: si,
            fare: fareFor(trip, originIdx, si),
          });
          break;
        }
      }
    }
    return rides;
  }

  // 乗換ハブ(2路線が近接するバス停ペア)を前計算
  const hubs = [];
  D.stops.forEach((a, i) => D.stops.forEach((b, j) => {
    if (a.feed === "miyawaka" && b.feed === "chikuho" &&
        distM(a.lat, a.lon, b.lat, b.lon) <= TRANSFER_HUB_DIST) {
      hubs.push([i, j]); hubs.push([j, i]);
    }
  }));

  function transferRides(originIdx, destIdxs, date, afterMin) {
    const rides = [];
    for (const [h1, h2] of hubs) {
      const leg1s = directRides(originIdx, [h1], date, afterMin);
      for (const l1 of leg1s) {
        const leg2s = directRides(h2, destIdxs, date, l1.arr + MIN_TRANSFER_MIN);
        for (const l2 of leg2s) {
          rides.push({
            legs: [l1.legs[0], l2.legs[0]],
            dep: l1.dep, arr: l2.arr, alight: l2.alight,
            fare: (l1.fare ?? 0) + (l2.fare ?? 0),
            hub: [h1, h2],
          });
        }
      }
    }
    return rides;
  }

  function search(originIdx, facility, date, afterMin) {
    // 目的地に近いバス停(徒歩圏内)
    const cand = D.stops.map((s, i) => ({ i, d: distM(s.lat, s.lon, facility.lat, facility.lon) }))
      .filter(x => x.d <= MAX_WALK_TO_STOP)
      .sort((a, b) => a.d - b.d);
    if (!cand.length) return { rides: [], reachable: false };
    const destIdxs = cand.map(c => c.i);
    const walkByIdx = Object.fromEntries(cand.map(c => [c.i, c.d]));

    let rides = directRides(originIdx, destIdxs, date, afterMin);
    if (!rides.length) rides = transferRides(originIdx, destIdxs, date, afterMin);
    rides.forEach(r => { r.walkM = walkByIdx[r.alight]; });
    rides.sort((a, b) => a.arr + walkMin(a.walkM) - (b.arr + walkMin(b.walkM)) || a.dep - b.dep);
    // 同時刻重複を除去して先頭3件
    const seen = new Set();
    const top = [];
    for (const r of rides) {
      const k = r.dep + "|" + r.arr + "|" + r.alight;
      if (seen.has(k)) continue;
      seen.add(k); top.push(r);
      if (top.length >= 3) break;
    }
    return { rides: top, reachable: true };
  }

  // ---------- UI ----------
  const $ = sel => document.querySelector(sel);
  const state = { cat: null, facility: null, originIdx: null, day: "today" };

  const SCREENS = { dest: $("#screen-dest"), origin: $("#screen-origin"), result: $("#screen-result") };
  function show(name) {
    Object.entries(SCREENS).forEach(([k, el]) => el.classList.toggle("hidden", k !== name));
    window.scrollTo(0, 0);
  }

  // 文字サイズ
  $("#font-toggle").addEventListener("click", () => {
    const xl = document.documentElement.classList.toggle("xl");
    $("#font-toggle").textContent = xl ? "文字を もどす" : "文字を大きく";
  });

  // STEP1: カテゴリ → 施設リスト
  document.querySelectorAll(".cat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.cat = btn.dataset.cat;
      renderFacList("");
      $("#fac-picker").classList.remove("hidden");
      $("#fac-filter").value = "";
      $("#fac-picker").scrollIntoView({ behavior: "smooth" });
    });
  });
  $("#fac-filter").addEventListener("input", e => renderFacList(e.target.value.trim()));

  function renderFacList(q) {
    const list = $("#fac-list");
    list.innerHTML = "";
    let items = D.facilities.filter(f => f.cat === state.cat);
    if (q) items = items.filter(f => f.name.includes(q) || f.kana.includes(q));
    items.sort((a, b) => (a.kana || a.name).localeCompare(b.kana || b.name, "ja"));
    for (const f of items.slice(0, 60)) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.innerHTML = `${esc(f.name)}<span class="sub">${esc(f.note)}</span>`;
      b.addEventListener("click", () => { state.facility = f; $("#dest-name").textContent = f.name; renderStopGroups(); show("origin"); });
      li.appendChild(b); list.appendChild(li);
    }
    if (!items.length) list.innerHTML = "<li>みつかりません</li>";
  }

  // STEP2: 乗る場所
  function renderStopGroups() {
    const wrap = $("#stop-groups");
    wrap.innerHTML = "";
    $("#geo-result").innerHTML = "";
    for (const feed of ["miyawaka", "chikuho"]) {
      const g = document.createElement("div");
      g.className = "route-group";
      g.innerHTML = `<h3>${esc(D.routeNames[feed])}</h3>`;
      const div = document.createElement("div");
      div.className = "stop-btns";
      const seen = new Set();
      D.stops.forEach((s, i) => {
        if (s.feed !== feed) return;
        const base = s.name;
        if (seen.has(base)) return;
        seen.add(base);
        const b = document.createElement("button");
        b.textContent = base;
        b.addEventListener("click", () => pickOrigin(i));
        div.appendChild(b);
      });
      g.appendChild(div); wrap.appendChild(g);
    }
  }

  $("#geo-btn").addEventListener("click", () => {
    $("#geo-result").textContent = "さがしています…";
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude: la, longitude: lo } = pos.coords;
      const near = D.stops.map((s, i) => ({ i, d: distM(s.lat, s.lon, la, lo) }))
        .sort((a, b) => a.d - b.d).slice(0, 4);
      const div = $("#geo-result");
      div.innerHTML = "<p>ちかくのバス停:</p>";
      const btns = document.createElement("div");
      btns.className = "stop-btns";
      const seen = new Set();
      for (const n of near) {
        const s = D.stops[n.i];
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        const b = document.createElement("button");
        b.textContent = `${s.name} (歩いて約${walkMin(n.d)}分)`;
        b.addEventListener("click", () => pickOrigin(n.i));
        btns.appendChild(b);
      }
      div.appendChild(btns);
    }, () => { $("#geo-result").textContent = "位置がわかりませんでした。下からバス停をえらんでください。"; });
  });

  function pickOrigin(idx) {
    state.originIdx = idx;
    $("#res-origin").textContent = D.stops[idx].name;
    $("#res-dest").textContent = state.facility.name;
    runSearch();
    show("result");
  }

  // STEP3: 結果
  $("#day-today").addEventListener("click", () => setDay("today"));
  $("#day-tomorrow").addEventListener("click", () => setDay("tomorrow"));
  function setDay(d) {
    state.day = d;
    $("#day-today").classList.toggle("active", d === "today");
    $("#day-tomorrow").classList.toggle("active", d === "tomorrow");
    runSearch();
  }

  function sameStopIdxs(idx) {
    // 同名バス停(上り/下りポール)をまとめて出発候補に
    const name = D.stops[idx].name, feed = D.stops[idx].feed;
    return D.stops.map((s, i) => (s.name === name && s.feed === feed ? i : -1)).filter(i => i >= 0);
  }

  function runSearch() {
    const now = new Date();
    let date = new Date(), afterMin;
    if (state.day === "tomorrow") { date.setDate(date.getDate() + 1); afterMin = 0; }
    else afterMin = now.getHours() * 60 + now.getMinutes();

    let best = { rides: [], reachable: false };
    for (const oi of sameStopIdxs(state.originIdx)) {
      const r = search(oi, state.facility, date, afterMin);
      best.reachable = best.reachable || r.reachable;
      best.rides = best.rides.concat(r.rides);
    }
    best.rides.sort((a, b) => a.arr - b.arr);
    best.rides = best.rides.slice(0, 3);
    renderResults(best, date);
  }

  function fmt(min) {
    const h = Math.floor(min / 60) % 24, m = min % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  }

  function renderResults(res, date) {
    const box = $("#results");
    box.innerHTML = "";
    if (!res.reachable) {
      box.innerHTML = `<div class="no-result"><b>この行き先の近くには バス停がありません。</b><br>
        下の「乗合タクシー・エリアワゴン」を ご利用ください。</div>`;
    } else if (!res.rides.length) {
      const dayLabel = state.day === "today" ? "きょう" : "あした";
      box.innerHTML = `<div class="no-result"><b>${dayLabel}は もう バスがありません。</b><br>
        「あした」を おしてみるか、下の「乗合タクシー・エリアワゴン」を ご利用ください。</div>`;
    } else {
      for (const r of res.rides) box.appendChild(rideCard(r));
    }
    renderWagon();
  }

  function rideCard(r) {
    const div = document.createElement("div");
    div.className = "ride-card";
    const alightStop = D.stops[r.alight];
    const wmin = walkMin(r.walkM);
    let html = `<div><span class="dep-time">${fmt(r.dep)}</span> 発`;
    html += `<span class="route-name">${esc(D.routeNames[r.legs[0].trip.feed])}</span></div>`;
    html += `<div class="leg">🚏 ${esc(D.stops[r.legs[0].from].name)} → `;
    if (r.legs.length === 2) {
      html += `${esc(D.stops[r.legs[0].to].name)} <b>(${fmt(r.legs[0].arr)}着)</b></div>`;
      html += `<div class="transfer-note">🔁 のりかえ: ${esc(D.stops[r.legs[1].from].name)} から
               <b>${fmt(r.legs[1].dep)}</b> 発 <span class="route-name">${esc(D.routeNames[r.legs[1].trip.feed])}</span></div>`;
      html += `<div class="leg">🚏 → ${esc(alightStop.name)} <b>(${fmt(r.arr)}着)</b></div>`;
    } else {
      html += `${esc(alightStop.name)} <b>(${fmt(r.arr)}着)</b></div>`;
    }
    html += `<div class="leg">🚶 バス停から歩いて 約${wmin}分</div>`;
    html += `<div class="fare">💰 運賃: ${r.fare == null ? "車内でご確認ください" : r.fare + "円"}</div>`;
    div.innerHTML = html;
    return div;
  }

  function renderWagon() {
    const w = D.wagon;
    $("#wagon-card").innerHTML = `<div class="wagon">
      <h3>🚕 乗合タクシー・エリアワゴン という方法もあります</h3>
      <p>${esc(w.fares)}。${esc(w.note)}</p>
      <p class="districts">対象地区: ${w.districts.map(esc).join("・")}</p>
      <p><a href="${w.url}" target="_blank" rel="noopener">飯塚市の予約・時刻の案内ページを見る →</a></p>
    </div>`;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // back buttons
  document.querySelectorAll(".back-btn").forEach(b =>
    b.addEventListener("click", () => show(b.dataset.back)));

  // ヘッドレステスト用
  window.__engine = { search, directRides, transferRides, serviceActive, fareFor, distM, hubs };
})();
