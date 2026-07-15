/* いいづか のりものナビ — 検索エンジン + UI (vanilla JS) */
(function () {
  "use strict";
  const D = window.APP_DATA;
  const WALK_M_PER_MIN = 60;          // 高齢者の歩行速度目安
  const DEFAULT_MAX_WALK = 500;       // 高齢者向け既定値。画面で300/500/800mを選択可
  const WALK_ONLY_M = 500;            // 乗車バス停が目的地に近く、バス不要と判断する距離(m)
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
    if (D.fares.flat && D.fares.flat[trip.feed] != null) return D.fares.flat[trip.feed];
    const from = D.stops[fromIdx], to = D.stops[toIdx];
    const p = D.fares.miyawaka[from.zone + "|" + to.zone];
    return p === undefined ? null : p;
  }

  // ---------- search ----------
  // 直行便: origin と destStops のどれかを順に通る便
  function directRides(originIdx, destIdxs, date, afterMin, ignoreSvc, walkOf) {
    const destSet = new Set(destIdxs);
    const rides = [];
    for (const trip of D.trips) {
      if (!ignoreSvc && !serviceActive(trip.feed, trip.service, date)) continue;
      let boardAt = -1, boardDep = 0, best = null;
      for (const [si, arr, dep, pu, doff] of trip.st) {
        if (boardAt < 0) {
          if (si === originIdx && pu !== 1 && dep >= afterMin) { boardAt = si; boardDep = dep; }
        } else if (destSet.has(si) && doff !== 1) {
          // walkOf があれば同じ便の中で「目的地に最も近い停留所」で降車(高齢者の徒歩を最小化)。
          // なければ最初の候補で確定(乗換の中間段など)。
          if (!walkOf) { best = { si, arr }; break; }
          if (!best || (walkOf[si] ?? Infinity) < (walkOf[best.si] ?? Infinity)) best = { si, arr };
        }
      }
      if (best) rides.push({
        legs: [{ trip, from: originIdx, to: best.si, dep: boardDep, arr: best.arr }],
        dep: boardDep, arr: best.arr, alight: best.si,
        fare: fareFor(trip, originIdx, best.si),
      });
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

  function transferRides(originIdx, destIdxs, date, afterMin, ignoreSvc) {
    const rides = [];
    for (const [h1, h2] of hubs) {
      const leg1s = directRides(originIdx, [h1], date, afterMin, ignoreSvc);
      for (const l1 of leg1s) {
        const leg2s = directRides(h2, destIdxs, date, l1.arr + MIN_TRANSFER_MIN, ignoreSvc);
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

  // 支配される便を除去: 同じ到着(時刻+下車停)なら出発が最も遅いものだけ残す
  // (朝7時に乗って乗換で3時間待つ、のような案内を防ぐ)
  function pruneRides(rides) {
    const bestByArr = new Map();
    for (const r of rides) {
      const k = r.arr + "|" + r.alight;
      const cur = bestByArr.get(k);
      if (!cur || r.dep > cur.dep) bestByArr.set(k, r);
    }
    return [...bestByArr.values()]
      .sort((a, b) => a.arr + walkMin(a.walkM ?? 0) - (b.arr + walkMin(b.walkM ?? 0)));
  }

  function search(originIdx, facility, date, afterMin, ignoreSvc, maxWalkM) {
    const walkLimit = maxWalkM || DEFAULT_MAX_WALK;
    // 目的地に近いバス停(徒歩圏内)
    const cand = D.stops.map((s, i) => ({ i, d: distM(s.lat, s.lon, facility.lat, facility.lon) }))
      .filter(x => x.d <= walkLimit)
      .sort((a, b) => a.d - b.d);
    if (!cand.length) return { rides: [], reachable: false };
    const destIdxs = cand.map(c => c.i);
    const walkByIdx = Object.fromEntries(cand.map(c => [c.i, c.d]));

    let rides = directRides(originIdx, destIdxs, date, afterMin, ignoreSvc, walkByIdx);
    if (!rides.length) rides = transferRides(originIdx, destIdxs, date, afterMin, ignoreSvc);
    rides.forEach(r => { r.walkM = walkByIdx[r.alight]; });
    return { rides: pruneRides(rides).slice(0, 3), reachable: true };
  }

  // バス停ごとの「行き先までの状況」を判定(灰色化に使用)
  //   ok:   今日これから乗れる便がある(nextDep: 最速の発車時刻)
  //   gone: 路線はつながっているが今日はもう便が無い
  //   dead: そもそもこの行き先へは行けない(曜日・時刻を問わず不通)
  function stopStatus(originIdx, facility) {
    const polls = sameStopIdxs(originIdx);
    const nearM = Math.min(...polls.map(oi =>
      distM(D.stops[oi].lat, D.stops[oi].lon, facility.lat, facility.lon)));
    if (nearM <= WALK_ONLY_M) return { state: "walk", walkM: nearM };
    const now = new Date();
    const afterMin = now.getHours() * 60 + now.getMinutes();
    let todayOk = false, nextDep = Infinity;
    for (const oi of polls) {
      const r = search(oi, facility, now, afterMin);
      if (r.rides.length) { todayOk = true; nextDep = Math.min(nextDep, r.rides[0].dep); }
    }
    if (todayOk) return { state: "ok", nextDep };
    // 構造的に到達可能か(運行日・時刻を無視)
    for (const oi of polls) {
      if (search(oi, facility, now, 0, true).rides.length) return { state: "gone" };
    }
    return { state: "dead" };
  }

  function makeStopButton(originIdx, walkLabel, originWalkM) {
    const s = D.stops[originIdx];
    const st = stopStatus(originIdx, state.facility);
    const b = document.createElement("button");
    b.className = "stop-btn " + st.state;
    let sub;
    if (st.state === "walk") sub = `歩いてすぐ・約${walkMin(st.walkM)}分`;
    else if (st.state === "ok") sub = `次 ${fmt(st.nextDep)}発`;
    else if (st.state === "gone") sub = "本日は運行終了";
    else sub = "この行き先へは行けません";
    if (walkLabel) sub = walkLabel + "・" + sub;
    b.innerHTML = `<span class="sn">${esc(s.name)}</span><span class="ss">${esc(sub)}</span>`;
    if (st.state === "dead") {
      b.disabled = true;
    } else {
      b.addEventListener("click", () => pickOrigin(originIdx, st.state === "gone" ? "tomorrow" : "today", originWalkM));
    }
    return b;
  }

  // 手動一覧は即時表示を優先。全停留所ごとの経路探索は端末負荷が高いため、
  // 選択後に一度だけ検索し、行けない場合は結果画面で理由と代替手段を示す。
  function makeManualStopButton(originIdx) {
    const s = D.stops[originIdx];
    const b = document.createElement("button");
    b.className = "stop-btn";
    b.innerHTML = `<span class="sn">${esc(s.name)}</span><span class="ss">ここから出発</span>`;
    b.addEventListener("click", () => pickOrigin(originIdx, "today", 0));
    return b;
  }

  // ---------- UI ----------
  const $ = sel => document.querySelector(sel);
  const state = {
    cat: null, facility: null, originIdx: null, day: "today",
    travelDate: null, originWalkM: 0, maxWalkM: DEFAULT_MAX_WALK,
  };

  const SCREENS = {
    dest: $("#screen-dest"), concierge: $("#screen-concierge"),
    origin: $("#screen-origin"), result: $("#screen-result")
  };
  function show(name) {
    Object.entries(SCREENS).forEach(([k, el]) => el.classList.toggle("hidden", k !== name));
    window.scrollTo(0, 0);
    document.querySelector(`#screen-${name} h2`)?.focus?.({ preventScroll: true });
  }

  // 文字サイズ
  $("#font-toggle").addEventListener("click", () => {
    const xl = document.documentElement.classList.toggle("xl");
    $("#font-toggle").textContent = xl ? "文字を もどす" : "文字を大きく";
    try { localStorage.setItem("norimono-font-xl", xl ? "1" : "0"); } catch (_) {}
  });
  let savedXL = false;
  try { savedXL = localStorage.getItem("norimono-font-xl") === "1"; } catch (_) {}
  if (savedXL) {
    document.documentElement.classList.add("xl");
    $("#font-toggle").textContent = "文字を もどす";
  }

  // ---------- 予約交通コンシェルジュ ----------
  const BOOKING = {
    phone: "0948216600",
    phoneLabel: "0948-21-6600",
    online: "https://c.casv.jp/pt/AreaPortal.html?a=51df0bbe-997d-4fd5-ae39-6bdea252ceaf",
    register: "https://shinsei.pref.fukuoka.lg.jp/SksJuminWeb/EntryForm?id=ASlpzG3B",
    credentials: "https://shinsei.pref.fukuoka.lg.jp/SksJuminWeb/EntryForm?id=KwKjNxtM",
    official: "https://www.city.iizuka.lg.jp/soshiki/16/10129.html"
  };
  const DISTRICT_RULES = {
    "頴田": { taxi: true, wagon: true, pause: [720, 780] }, "鯰田": { taxi: true, wagon: true, pause: [720, 780] },
    "幸袋": { taxi: true, wagon: true, pause: [720, 780] }, "鎮西": { taxi: true, wagon: true, pause: [690, 750] },
    "二瀬": { taxi: true, wagon: true, pause: [750, 810] }, "穂波": { taxi: true, wagon: true },
    "筑穂": { taxi: true, wagon: true }, "飯塚東": { taxi: true, wagon: true, pause: [740, 800] },
    "庄内": { taxi: true, wagon: true, pause: [740, 800] }, "菰田": { taxi: false, wagon: true },
    "立岩": { taxi: false, wagon: false }, "飯塚・片島": { taxi: false, wagon: false }
  };
  const HOLIDAYS_2026 = new Set([
    "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20",
    "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06",
    "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23",
    "2026-10-12", "2026-11-03", "2026-11-23"
  ]);
  function isTaxiClosedDate(date) {
    const md = (date.getMonth() + 1) * 100 + date.getDate();
    return date.getDay() === 0 || date.getDay() === 6 || HOLIDAYS_2026.has(localDateValue(date)) ||
      (md >= 813 && md <= 815) || md >= 1229 || md <= 103;
  }
  function addDays(date, days) {
    const d = new Date(date); d.setDate(d.getDate() + days); return d;
  }
  function previousBusinessDay(date) {
    let d = addDays(date, -1);
    while (isTaxiClosedDate(d)) d = addDays(d, -1);
    return d;
  }
  function dateTime(dateValue, timeValue) {
    if (!dateValue || !timeValue) return null;
    const [y, m, d] = dateValue.split("-").map(Number);
    const [hh, mm] = timeValue.split(":").map(Number);
    const value = new Date(y, m - 1, d, hh, mm, 0, 0);
    return Number.isNaN(value.getTime()) ? null : value;
  }
  function shortDate(date) {
    return `${date.getMonth() + 1}/${date.getDate()}（${WD[date.getDay()]}）`;
  }
  function evaluateConcierge(input, now = new Date()) {
    const rule = DISTRICT_RULES[input.district];
    const ride = dateTime(input.date, input.time);
    if (!rule || !ride) return { status: "input", title: "地区・利用日時を選んでください" };
    if (!rule.taxi) return {
      status: rule.wagon ? "wagon" : "fixed", title: "予約乗合タクシーの対象地区ではありません",
      district: input.district, wagon: rule.wagon,
      detail: rule.wagon
        ? `${input.district}地区はエリアワゴン／路線ワゴンの対象です。運行曜日と停留所を確認してください。`
        : `${input.district}地区は定時の路線バスなどを確認してください。`
    };
    if (isTaxiClosedDate(ride)) return {
      status: "closed", title: "この日は予約乗合タクシーが運休です", district: input.district,
      detail: "予約乗合タクシーは平日のみ運行します。地区のワゴンまたは定時バスの運行をご確認ください。"
    };
    const mins = ride.getHours() * 60 + ride.getMinutes();
    if (mins < 480 || mins > 1020) return {
      status: "closed", title: "希望時刻が運行時間外です", district: input.district,
      detail: "予約乗合タクシーの運行時間は8:00〜17:00です。時間を変更して再判定してください。"
    };
    if (rule.pause && mins >= rule.pause[0] && mins < rule.pause[1]) return {
      status: "closed", title: "この時間は地区の休憩時間です", district: input.district,
      detail: `${input.district}地区は${Math.floor(rule.pause[0] / 60)}:${String(rule.pause[0] % 60).padStart(2,"0")}〜${Math.floor(rule.pause[1] / 60)}:${String(rule.pause[1] % 60).padStart(2,"0")}の間、予約乗合タクシーを利用できません。時間を変更してください。`
    };
    const onlineOpens = addDays(ride, -5);
    const phoneOpens = addDays(ride, -7);
    const onlineDeadline = new Date(ride.getTime() - 60 * 60 * 1000);
    const phoneDeadline = ride.getHours() < 9
      ? new Date(previousBusinessDay(ride).setHours(16, 30, 0, 0))
      : new Date(ride.getTime() - 60 * 60 * 1000);
    const expired = now > onlineDeadline;
    let status = expired ? "expired"
      : input.registered === "yes" ? "ready"
      : input.registered === "no" ? "register" : "verify";
    let title = expired ? "この便の予約期限を過ぎています"
      : input.registered === "yes" ? "予約乗合タクシーの対象地区です"
      : input.registered === "no" ? "先に利用登録が必要です" : "登録状況を確認しましょう";
    return {
      status, title, district: input.district, ride, tripKind: input.tripKind,
      registered: input.registered, onlineOpens, phoneOpens, onlineDeadline, phoneDeadline,
      onlineBookable: now >= onlineOpens && now <= onlineDeadline,
      phoneBookable: now >= phoneOpens && now <= phoneDeadline,
      expired
    };
  }
  function tripPlan(kind) {
    if (kind === "other") return {
      title: "別地区へは乗り継ぎの相談が必要です",
      advice: "予約乗合タクシー同士を乗り継ぐ場合があります。予約時に最終目的地を伝えてください。",
      action: "phone"
    };
    if (kind === "center") return {
      title: "定時バスへの乗り継ぎを案内します",
      advice: "地区内の停留所まで予約交通を使い、そこから定時バスへ乗り継げます。先にバスの時刻を確認しましょう。",
      action: "bus"
    };
    if (kind === "facility") return {
      title: "地区外は指定施設のみ利用できます",
      advice: "病院・駅・商業施設など、地区ごとに利用できる施設が決まっています。予約前に対象施設を確認してください。",
      action: "facilities"
    };
    return {
      title: "同じ地区の中を移動できます",
      advice: "地区内の指定乗降場所どうしを利用できます。運賃は1乗車300円です。",
      action: "booking"
    };
  }
  function tripActionButtons(plan) {
    if (plan.action === "phone") {
      return `<a class="answer-action secondary" href="tel:${BOOKING.phone}">乗り継ぎを電話で相談する<br><small>${BOOKING.phoneLabel}</small></a>`;
    }
    if (plan.action === "bus") {
      return `<button class="answer-action secondary js-fixed-search">乗り継ぐバスをこのアプリで探す</button>`;
    }
    if (plan.action === "facilities") {
      return `<a class="answer-action secondary" href="https://www.city.iizuka.lg.jp/shokotaisaku/machi/kotsu/bus/documents/yoyaku.pdf" target="_blank" rel="noopener">地区外で行ける施設を確認する</a>`;
    }
    return "";
  }
  function renderConcierge(result) {
    const box = $("#concierge-result");
    if (result.status === "input") {
      box.innerHTML = `<div class="concierge-answer warning"><h3>${esc(result.title)}</h3></div>`;
      return;
    }
    if (result.status === "wagon" || result.status === "fixed" || result.status === "closed") {
      const link = result.wagon
        ? `<a class="answer-action secondary" href="https://www.city.iizuka.lg.jp/soshiki/16/2030.html" target="_blank" rel="noopener">地区の時刻表を確認する</a>`
        : `<button class="answer-action secondary js-fixed-search">定時バスをこのアプリで探す</button>`;
      box.innerHTML = `<article class="concierge-answer ${result.status}"><span class="answer-badge">判定結果</span><h3>${esc(result.title)}</h3><p>${esc(result.detail)}</p><div class="answer-actions">${link}</div></article>`;
      return;
    }
    const register = result.registered === "no"
      ? `<li><b>最初に利用登録</b><span>登録処理には2〜4日かかります。</span></li>`
      : result.registered === "unknown"
        ? `<li><b>登録状況を確認</b><span>ID・パスワードの確認手続き、または予約センターへの電話で確認できます。</span></li>` : "";
    const bookingState = result.expired ? `<li><b>この日時は予約不可</b><span>別の日時を選んで再判定してください。</span></li>`
      : `<li><b>電話受付</b><span>7日前から ${shortDate(result.phoneDeadline)} ${result.phoneDeadline.getHours()}:${String(result.phoneDeadline.getMinutes()).padStart(2,"0")}まで</span></li>
         <li><b>ネット受付</b><span>5日前から利用1時間前まで</span></li>`;
    const onlineButton = result.onlineBookable && result.registered === "yes"
      ? `<a class="answer-action" href="${BOOKING.online}" target="_blank" rel="noopener">ネットで予約する</a>` : "";
    const phoneButton = result.phoneBookable && result.registered === "yes"
      ? `<a class="answer-action" href="tel:${BOOKING.phone}">電話で予約する<br><small>${BOOKING.phoneLabel}</small></a>` : "";
    const registrationButtons = result.registered === "no"
      ? `<a class="answer-action" href="${BOOKING.register}" target="_blank" rel="noopener">利用登録を始める</a>`
      : result.registered === "unknown"
        ? `<a class="answer-action" href="${BOOKING.credentials}" target="_blank" rel="noopener">ID・パスワードを確認する</a>
           <a class="answer-action secondary" href="tel:${BOOKING.phone}">電話で登録状況を確認する<br><small>${BOOKING.phoneLabel}</small></a>` : "";
    const plan = tripPlan(result.tripKind);
    box.innerHTML = `<article class="concierge-answer ${result.status}">
      <span class="answer-badge">あなたの判定結果</span><h3>${esc(result.title)}</h3>
      <p class="answer-route"><b>${esc(result.district)}地区</b>・${shortDate(result.ride)} ${result.ride.getHours()}:${String(result.ride.getMinutes()).padStart(2,"0")}</p>
      <div class="trip-verdict"><b>${esc(plan.title)}</b><span>${esc(plan.advice)}</span></div>
      <ol class="next-steps">${register}${bookingState}</ol>
      <div class="answer-actions">${tripActionButtons(plan)}${registrationButtons}${onlineButton}${phoneButton}</div>
      ${result.registered === "yes" ? `<p class="credential-link"><a href="${BOOKING.credentials}" target="_blank" rel="noopener">ネット予約のID・パスワードがわからない方</a></p>` : ""}
      <p class="official-link"><a href="${BOOKING.official}" target="_blank" rel="noopener">飯塚市の公式案内で確認する</a></p>
    </article>`;
  }
  $("#concierge-start").addEventListener("click", () => show("concierge"));
  const suggestedDate = addDays(new Date(), 2);
  $("#concierge-date").min = localDateValue(new Date());
  $("#concierge-date").value = localDateValue(suggestedDate);
  $("#check-transport").addEventListener("click", () => renderConcierge(evaluateConcierge({
    district: $("#home-district").value, tripKind: $("#trip-kind").value,
    registered: $("#taxi-registered").value, date: $("#concierge-date").value,
    time: $("#concierge-time").value
  })));
  $("#concierge-result").addEventListener("click", e => {
    if (e.target.closest(".js-fixed-search")) show("dest");
  });

  // STEP1: カテゴリ → 施設リスト
  document.querySelectorAll(".cat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.cat = btn.dataset.cat;
      renderFacList("");
      $("#fac-picker").classList.remove("hidden");
      $("#about-banner").classList.add("hidden");
      $("#fac-filter").value = "";
      $("#fac-picker").scrollIntoView({ behavior: "smooth" });
    });
  });
  $("#fac-filter").addEventListener("input", e => renderFacList(e.target.value.trim()));

  const toKata = s => s.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));

  function renderFacList(q) {
    const list = $("#fac-list");
    list.innerHTML = "";
    let items = D.facilities.filter(f => f.cat === state.cat);
    if (q) {
      const kq = toKata(q);
      items = items.filter(f => f.name.includes(q) || f.kana.includes(kq) ||
                                toKata(f.name).includes(kq));
    }
    // 病院を先頭に(pri降順)、あとは五十音順
    items.sort((a, b) => (b.pri || 0) - (a.pri || 0) ||
      (a.kana || a.name).localeCompare(b.kana || b.name, "ja"));
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
    // 行き先の徒歩圏にバス停が無ければ、灰色の一覧を出さず直接案内
    const hasNearby = D.stops.some(s =>
      distM(s.lat, s.lon, state.facility.lat, state.facility.lon) <= 800);
    if (!hasNearby) {
      $("#geo-btn").classList.add("hidden");
      wrap.innerHTML =
        `<div class="no-result"><b>「${esc(state.facility.name)}」の近くにはバス停がありません。</b><br>
         コミュニティバスでは行きにくい場所です。下の方法をご利用ください。</div>` + wagonHTML();
      return;
    }
    $("#geo-btn").classList.remove("hidden");
    const feeds = [...new Set(D.stops.map(s => s.feed))];
    for (const feed of feeds) {
      const g = document.createElement("div");
      g.className = "route-group";
      g.innerHTML = `<h3>${esc(D.routeNames[feed])}</h3>`;
      const div = document.createElement("div");
      div.className = "stop-btns";
      const seen = new Set();
      D.stops.forEach((s, i) => {
        if (s.feed !== feed) return;
        if (seen.has(s.name)) return;
        seen.add(s.name);
        div.appendChild(makeManualStopButton(i));
      });
      g.appendChild(div); wrap.appendChild(g);
    }
  }

  $("#geo-btn").addEventListener("click", () => {
    $("#geo-btn").disabled = true;
    $("#geo-btn").textContent = "現在地を確認しています…";
    $("#geo-result").textContent = "位置情報の利用を許可してください。";
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude: la, longitude: lo } = pos.coords;
      const near = D.stops.map((s, i) => ({ i, d: distM(s.lat, s.lon, la, lo) }))
        .filter(x => x.d <= 1200)
        .sort((a, b) => a.d - b.d).slice(0, 10);
      const div = $("#geo-result");
      $("#geo-btn").disabled = false;
      $("#geo-btn").textContent = "現在地を更新する";
      div.innerHTML = "<p><b>ここから乗りやすいバス停</b><br><small>歩く時間を含め、間に合う便を案内します。</small></p>";
      const btns = document.createElement("div");
      btns.className = "stop-btns";
      const seen = new Set();
      let shown = 0;
      for (const n of near) {
        const s = D.stops[n.i];
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        btns.appendChild(makeStopButton(n.i, `歩いて約${walkMin(n.d)}分・${Math.round(n.d)}m`, n.d));
        if (++shown >= 4) break;
      }
      if (shown) div.appendChild(btns);
      else div.innerHTML = '<div class="no-result"><b>歩いて行ける範囲にバス停が見つかりませんでした。</b><br>下からバス停を選ぶか、乗合タクシーをご確認ください。</div>';
    }, () => {
      $("#geo-btn").disabled = false;
      $("#geo-btn").textContent = "もう一度、現在地から探す";
      $("#geo-result").innerHTML = '<div class="no-result"><b>現在地を確認できませんでした。</b><br>端末の位置情報を許可するか、下からバス停を選んでください。</div>';
      $("#stop-lists").open = true;
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });

  function pickOrigin(idx, day, originWalkM) {
    state.originIdx = idx;
    state.originWalkM = originWalkM || 0;
    $("#res-origin").textContent = D.stops[idx].name;
    $("#res-dest").textContent = state.facility.name;
    setDay(day || "today");
    show("result");
  }

  // STEP3: 結果
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  function dayLabel(offset, base) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${base}(${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]})`;
  }
  $("#day-today").textContent = dayLabel(0, "今日");
  $("#day-tomorrow").textContent = dayLabel(1, "明日");
  $("#day-today").addEventListener("click", () => setDay("today"));
  $("#day-tomorrow").addEventListener("click", () => setDay("tomorrow"));
  $("#travel-date").min = localDateValue(new Date());
  $("#travel-date").addEventListener("change", e => {
    if (!e.target.value) return;
    state.day = "date";
    state.travelDate = e.target.value;
    $("#day-today").classList.remove("active");
    $("#day-tomorrow").classList.remove("active");
    runSearch();
  });
  $("#walk-limit").addEventListener("change", e => {
    state.maxWalkM = Number(e.target.value);
    runSearch();
  });

  function localDateValue(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function setDay(d) {
    state.day = d;
    state.travelDate = null;
    $("#travel-date").value = "";
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
    if (state.day === "tomorrow") {
      date.setDate(date.getDate() + 1); afterMin = 0;
    } else if (state.day === "date" && state.travelDate) {
      const [y, m, d] = state.travelDate.split("-").map(Number);
      date = new Date(y, m - 1, d); afterMin = 0;
    } else {
      // 現在地から停留所まで歩く時間 + 2分の乗車余裕を含める
      afterMin = now.getHours() * 60 + now.getMinutes()
        + (state.originWalkM ? walkMin(state.originWalkM) + 2 : 0);
    }

    let best = { rides: [], reachable: false };
    for (const oi of sameStopIdxs(state.originIdx)) {
      const r = search(oi, state.facility, date, afterMin, false, state.maxWalkM);
      best.reachable = best.reachable || r.reachable;
      best.rides = best.rides.concat(r.rides);
    }
    best.rides = pruneRides(best.rides).slice(0, 3);
    const nowMin = state.day === "today" ? now.getHours() * 60 + now.getMinutes() : null;
    renderResults(best, date, nowMin);
  }

  function fmt(min) {
    const h = Math.floor(min / 60) % 24, m = min % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  }

  function renderResults(res, date, nowMin) {
    const box = $("#results");
    box.innerHTML = "";
    if (nowMin != null) {
      const clock = document.createElement("p");
      clock.className = "now-clock";
      clock.textContent = `🕐 いま ${fmt(nowMin)}`;
      box.appendChild(clock);
    }
    // 乗車バス停が目的地のすぐそば → バス不要
    const od = distM(D.stops[state.originIdx].lat, D.stops[state.originIdx].lon,
                     state.facility.lat, state.facility.lon);
    if (od <= WALK_ONLY_M) {
      box.innerHTML =
        `<div class="ride-card"><div class="dep-time">🚶 歩いてすぐ</div>
         <div class="leg"><b>${esc(state.facility.name)}</b>は、このバス停から歩いて約${walkMin(od)}分です。</div>
         <div class="leg">バスに乗る必要はありません。</div>
         <div class="leg">${walkMapLink(state.facility)}</div></div>`;
      $("#wagon-card").innerHTML = "";
      return;
    }
    if (!res.reachable) {
      box.innerHTML = `<div class="no-result"><b>この行き先の近くにはバス停がありません。</b><br>
        下の「乗合タクシー・エリアワゴン」をご利用ください。</div>`;
    } else if (!res.rides.length) {
      const dl = state.day === "today" ? "今日" : state.day === "tomorrow" ? "明日"
        : `${date.getMonth() + 1}/${date.getDate()}（${WD[date.getDay()]}）`;
      const alt = state.day === "today"
        ? "「明日」を押してみるか、下の「乗合タクシー・エリアワゴン」をご利用ください。"
        : "下の「乗合タクシー・エリアワゴン」をご利用ください。";
      box.innerHTML = `<div class="no-result"><b>${dl}は、この行き先へのバスがありません。</b><br>${alt}</div>`;
    } else {
      res.rides.forEach((r, i) => box.appendChild(rideCard(r, nowMin, i === 0)));
    }
    renderWagon();
  }

  function rideCard(r, nowMin, recommended) {
    const div = document.createElement("div");
    div.className = "ride-card" + (recommended ? " recommended" : "");
    const alightStop = D.stops[r.alight];
    const wmin = walkMin(r.walkM);
    const inMin = nowMin != null ? r.dep - nowMin : null;
    const soonTxt = inMin === 0 ? "まもなく"
      : inMin >= 60 ? `あと${Math.floor(inMin / 60)}時間${inMin % 60}分`
      : `あと${inMin}分`;
    const soon = inMin != null && inMin >= 0 ? `<span class="soon">${soonTxt}</span>` : "";
    const rideMin = r.arr - r.dep;
    let html = `<div><span class="dep-time">${fmt(r.dep)}</span> 発 ${soon}`;
    html += routeBadge(r.legs[0].trip.feed) + `</div>`;
    if (state.originWalkM) {
      const leaveAt = r.dep - walkMin(state.originWalkM) - 2;
      html += `<div class="leave-banner"><small>いまいる場所を<br>出る目安</small><strong>${fmt(leaveAt)} まで</strong></div>`;
    }
    html += `<div class="leg">🚏 ${stopMapLink(r.legs[0].from)} → `;
    if (r.legs.length === 2) {
      const waitMin = r.legs[1].dep - r.legs[0].arr;
      const waitStr = waitMin >= 60
        ? `約${Math.floor(waitMin / 60)}時間${waitMin % 60 ? (waitMin % 60) + "分" : ""}`
        : `約${waitMin}分`;
      html += `${stopMapLink(r.legs[0].to)} <b>(${fmt(r.legs[0].arr)}着)</b></div>`;
      html += `<div class="transfer-note">🔁 乗り換え: ${stopMapLink(r.legs[1].from)} から
               <b>${fmt(r.legs[1].dep)}</b> 発 ${routeBadge(r.legs[1].trip.feed)}<br>
               ⏳ 待ち時間 ${waitStr}</div>`;
      html += `<div class="leg">🚏 → ${stopMapLink(r.alight)} <b>(${fmt(r.arr)}着)</b></div>`;
    } else {
      html += `${stopMapLink(r.alight)} <b>(${fmt(r.arr)}着)</b></div>`;
    }
    html += `<div class="leg">🚶 <b>${esc(alightStop.name)}</b>で降りて、目的地まで約${wmin}分（${Math.round(r.walkM)}m） ${walkMapLink(state.facility)}</div>`;
    html += `<div class="fare-row"><span class="fare">💰 運賃: ${r.fare == null ? "車内でご確認ください" : r.fare + "円"}</span>`;
    html += `<span class="ride-dur">所要 約${rideMin}分(${fmt(r.dep)}〜${fmt(r.arr)})</span></div>`;
    html += `<div class="detail-grid"><span>📍 乗る場所<br><b>${stopMapLink(r.legs[0].from)}</b></span><span>🏁 到着目安<br><b>${fmt(r.arr + wmin)}</b></span></div>`;
    if (state.facility.tel) {
      html += `<p><a class="map-link" href="tel:${esc(state.facility.tel.replace(/-/g, ""))}">📞 ${esc(state.facility.name)}に電話する（${esc(state.facility.tel)}）</a></p>`;
    }
    div.innerHTML = html;
    return div;
  }

  function wagonHTML() {
    const w = D.wagon;
    const tel = w.reserveTel
      ? `<a class="tel-btn" href="tel:${w.reserveTel.replace(/-/g, "")}">📞 予約センターに電話する<span>${esc(w.reserveTel)}</span></a>
         <p class="tel-note">${esc(w.reserveHours || "")}<br>${esc(w.reserveNote || "")}</p>`
      : "";
    return `<div class="wagon">
      <h3>🚕 予約交通が使えるか、先に判定できます</h3>
      <p>地区・利用日・時刻から、予約乗合タクシーの対象と予約期限を確認します。</p>
      <button class="answer-action js-open-concierge">予約交通コンシェルジュを使う</button>
      ${tel}
      <p><a href="${w.url}" target="_blank" rel="noopener">飯塚市の公式案内を見る</a></p>
    </div>`;
  }
  function renderWagon() { $("#wagon-card").innerHTML = wagonHTML(); }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Google マップの徒歩経路リンク(出発地は端末の現在地)
  function walkMapLink(facility) {
    const url = "https://www.google.com/maps/dir/?api=1&travelmode=walking&destination="
      + facility.lat + "," + facility.lon;
    return `<a class="map-link" href="${url}" target="_blank" rel="noopener">🗺️ 地図で歩き方を見る</a>`;
  }

  // 現在地から指定した停留所までの徒歩ナビ。位置情報はGoogle Maps側で取得する。
  function stopMapLink(stopIdx) {
    const stop = D.stops[stopIdx];
    const url = "https://www.google.com/maps/dir/?api=1&travelmode=walking&destination="
      + stop.lat + "," + stop.lon;
    return `<a class="stop-map-link" href="${url}" target="_blank" rel="noopener" aria-label="現在地から${esc(stop.name)}までの地図を開く">${esc(stop.name)}</a>`;
  }

  const isWagon = feed => (D.wagonFeeds || []).includes(feed);
  function routeBadge(feed) {
    return `<span class="route-name${isWagon(feed) ? " wagon" : ""}">${esc(D.routeNames[feed])}</span>`;
  }

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  $("#share-btn").addEventListener("click", async () => {
    const text = `${D.stops[state.originIdx].name}から${state.facility.name}への行き方を「いいづか のりものナビ」で確認しました。`;
    const payload = { title: "いいづか のりものナビ", text, url: location.href };
    try {
      if (navigator.share) await navigator.share(payload);
      else {
        await navigator.clipboard.writeText(`${text}\n${location.href}`);
        toast("行き方のリンクをコピーしました");
      }
    } catch (err) {
      if (err?.name !== "AbortError") toast("共有できませんでした");
    }
  });

  $("#restart-btn").addEventListener("click", () => {
    state.facility = null;
    state.originIdx = null;
    state.originWalkM = 0;
    document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"));
    $("#fac-picker").classList.add("hidden");
    $("#about-banner").classList.remove("hidden");
    show("dest");
  });

  // back buttons
  document.querySelectorAll(".back-btn").forEach(b =>
    b.addEventListener("click", () => show(b.dataset.back)));
  $("#wagon-card").addEventListener("click", e => {
    if (e.target.closest(".js-open-concierge")) show("concierge");
  });

  // ヘッドレステスト用
  window.__engine = { search, directRides, transferRides, serviceActive, fareFor, distM, hubs, evaluateConcierge, isTaxiClosedDate, tripPlan };
})();
