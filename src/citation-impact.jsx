import { useState, useRef, useCallback } from "react";
import { BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

const C = {
  bg: "#060b16", surface: "#0d1424", surfaceLight: "#141e33", border: "#1a2744",
  accent: "#d4a012", accentDim: "#d4a01233", blue: "#4d8ef7", blueDim: "#4d8ef722",
  cyan: "#22d3ee", emerald: "#34d399", rose: "#fb7185", purple: "#a78bfa",
  text: "#e8edf5", textSec: "#8694ad", textMut: "#556378",
};
const PIE_C = [C.blue, C.accent, C.emerald, C.rose, C.purple, C.cyan];
const OA = "https://api.openalex.org";

let _mailto = "";
function qs() { return _mailto ? `mailto=${encodeURIComponent(_mailto)}` : ""; }

function sectorLabel(type) {
  if (!type) return "Other";
  const m = { education: "University", company: "Industry", government: "Government", healthcare: "Medical", nonprofit: "Nonprofit", facility: "Facility" };
  return m[type] || "Other";
}

function sectorColor(s) {
  return s === "University" ? C.blue : s === "Industry" ? C.accent : s === "Government" ? C.emerald : s === "Medical" ? C.rose : C.purple;
}

function buildUrl(path) {
  const base = path.startsWith("http") ? path : `${OA}${path}`;
  const m = qs();
  if (!m) return base;
  return base + (base.includes("?") ? "&" : "?") + m;
}

async function oaFetch(path, retries = 2) {
  const url = buildUrl(path);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    if (r.status === 429) {
      await new Promise(x => setTimeout(x, 3000 * (attempt + 1)));
      continue;
    }
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("json")) {
      const snippet = await r.text().then(t => t.slice(0, 120));
      throw new Error(`Expected JSON from OpenAlex but got "${ct}" (status ${r.status}). Check if api.openalex.org is reachable. Response: ${snippet}`);
    }
    if (!r.ok) throw new Error(`OpenAlex API error ${r.status}`);
    return r.json();
  }
  throw new Error("OpenAlex rate limited — wait a moment and try again");
}
const wait = ms => new Promise(r => setTimeout(r, ms));

function detectInput(q) {
  const t = q.trim();
  if (/^10\.\d{4,}\//.test(t)) return { type: "doi", id: t };
  if (/doi\.org\//.test(t)) { const m = t.match(/doi\.org\/(10\..+)/); if (m) return { type: "doi", id: m[1] }; }
  if (/openalex\.org\/W\d+/.test(t)) { const m = t.match(/(W\d+)/); if (m) return { type: "oaid", id: m[1] }; }
  if (/^\d{4}\.\d{4,}/.test(t)) return { type: "search", id: `arxiv:${t}` };
  if (/arxiv\.org\/abs\//.test(t)) { const m = t.match(/abs\/(\d{4}\.\d{4,})/); if (m) return { type: "search", id: `arxiv:${m[1]}` }; }
  return { type: "search", id: t };
}

function shortId(oaId) {
  if (!oaId) return "";
  return oaId.replace("https://openalex.org/", "");
}

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.text }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => <div key={i} style={{ color: p.color }}>{p.name}: {p.value?.toLocaleString?.() ?? p.value}</div>)}
    </div>
  );
};

function Hdr({ children, sub }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, fontFamily: "'Playfair Display', serif", margin: 0, borderLeft: `3px solid ${C.accent}`, paddingLeft: 14 }}>{children}</h2>
      {sub && <p style={{ fontSize: 12, color: C.textMut, margin: "5px 0 0 17px", fontFamily: "'JetBrains Mono', monospace" }}>{sub}</p>}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("landing");
  const [query, setQuery] = useState("");
  const [mailto, setMailto] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [paper, setPaper] = useState(null);
  const [prog, setProg] = useState({ pct: 0, msg: "" });
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("overview");
  const [err, setErr] = useState("");
  const abort = useRef(false);

  const updateMailto = (v) => { setMailto(v); _mailto = v; };

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setErr(""); setSearching(true);
    const inp = detectInput(q);
    try {
      if (inp.type === "doi") {
        const p = await oaFetch(`/works/doi:${inp.id}?select=id,doi,title,authorships,publication_year,cited_by_count,primary_location,type`);
        setResults([p]);
      } else if (inp.type === "oaid") {
        const p = await oaFetch(`/works/${inp.id}?select=id,doi,title,authorships,publication_year,cited_by_count,primary_location,type`);
        setResults([p]);
      } else {
        const res = await oaFetch(`/works?search=${encodeURIComponent(inp.id)}&per_page=8&select=id,doi,title,authorships,publication_year,cited_by_count,primary_location,type`);
        setResults(res.results || []);
        if (!res.results?.length) setErr("No papers found. Try different keywords or a DOI.");
      }
      setView("results");
    } catch (e) {
      setErr("Search failed: " + e.message);
    }
    setSearching(false);
  }, [query]);

  const analyze = useCallback(async (p) => {
    setPaper(p);
    setView("analyzing");
    setTab("overview");
    abort.current = false;
    setProg({ pct: 5, msg: "Loading paper details…" });

    try {
      // 1. Full paper details
      const full = await oaFetch(`/works/${shortId(p.id)}?select=id,doi,title,authorships,publication_year,cited_by_count,primary_location,type,topics,concepts`);
      setPaper(full);
      if (abort.current) return;
      setProg({ pct: 10, msg: "Fetching citations…" });

      // 2. Fetch all citing works (cursor pagination, 200/page)
      let allCit = [];
      let cursor = "*";
      const maxPages = 15; // 200 * 15 = 3000 max
      let page = 0;
      const totalExpected = full.cited_by_count || 1;

      while (cursor && page < maxPages) {
        if (abort.current) return;
        const batch = await oaFetch(`/works?filter=cites:${shortId(full.id)}&per_page=200&cursor=${cursor}&select=id,doi,title,authorships,publication_year,cited_by_count,primary_location`);
        const items = batch.results || [];
        allCit.push(...items);
        cursor = batch.meta?.next_cursor || null;
        page++;
        setProg({
          pct: 10 + Math.min(55, (allCit.length / totalExpected) * 55),
          msg: `Loaded ${allCit.length.toLocaleString()} of ~${totalExpected.toLocaleString()} citations…`
        });
        if (items.length < 200) break;
        await wait(120);
      }

      if (abort.current) return;
      setProg({ pct: 67, msg: "Analyzing citations…" });
      await wait(100);

      // 3. Aggregate everything from citation data
      const yearMap = {};
      const venueMap = {};
      const authorFreq = {};
      const instMap = {};
      const sectorMap = {};
      const highlyCited = [];

      for (const cp of allCit) {
        // Year
        if (cp.publication_year) yearMap[cp.publication_year] = (yearMap[cp.publication_year] || 0) + 1;

        // Venue
        const venue = cp.primary_location?.source?.display_name;
        if (venue) venueMap[venue] = (venueMap[venue] || 0) + 1;

        // Highly cited
        if (cp.cited_by_count >= 100) highlyCited.push(cp);

        // Authors and institutions
        if (cp.authorships) {
          for (const auth of cp.authorships) {
            const aid = auth.author?.id;
            const aname = auth.author?.display_name;
            if (aid && aname) {
              if (!authorFreq[aid]) authorFreq[aid] = { id: aid, name: aname, count: 0, institutions: [] };
              authorFreq[aid].count++;
              if (auth.institutions?.length && !authorFreq[aid].institutions.length) {
                authorFreq[aid].institutions = auth.institutions;
              }
            }
            // Institutions
            if (auth.institutions) {
              for (const inst of auth.institutions) {
                const iname = inst.display_name;
                if (iname) {
                  const sec = sectorLabel(inst.type);
                  if (!instMap[iname]) instMap[iname] = { name: iname, count: 0, sector: sec, country: inst.country_code || "" };
                  instMap[iname].count++;
                  sectorMap[sec] = (sectorMap[sec] || 0) + 1;
                }
              }
            }
          }
        }
      }

      // Timeline
      const years = Object.keys(yearMap).sort();
      let cum = 0;
      const timeline = years.map(y => { cum += yearMap[y]; return { year: String(y), annual: yearMap[y], cumulative: cum }; });

      // Venues sorted
      const venues = Object.entries(venueMap)
        .filter(([v]) => v.length > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([name, count]) => ({ name, count }));

      // Institutions sorted
      const institutions = Object.values(instMap).sort((a, b) => b.count - a.count).slice(0, 15);

      // Sectors
      const sectors = Object.entries(sectorMap).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

      // Top authors by citing frequency
      const topAuthors = Object.values(authorFreq).sort((a, b) => b.count - a.count).slice(0, 20);

      // 4. Enrich top authors with h-index (OpenAlex author endpoint)
      setProg({ pct: 70, msg: "Fetching scholar profiles…" });
      const enriched = [];
      const toFetch = Math.min(topAuthors.length, 15);
      for (let i = 0; i < toFetch; i++) {
        if (abort.current) return;
        try {
          const ad = await oaFetch(`/authors/${shortId(topAuthors[i].id)}?select=id,display_name,cited_by_count,summary_stats,last_known_institutions,works_count`);
          enriched.push({
            id: ad.id,
            name: ad.display_name,
            hIndex: ad.summary_stats?.h_index || 0,
            citationCount: ad.cited_by_count || 0,
            worksCount: ad.works_count || 0,
            affiliation: ad.last_known_institutions?.[0]?.display_name || topAuthors[i].institutions?.[0]?.display_name || "—",
            citingCount: topAuthors[i].count,
          });
          setProg({ pct: 70 + ((i + 1) / toFetch) * 26, msg: `Profiling scholar ${i + 1}/${toFetch}…` });
          await wait(120);
        } catch { /* skip */ }
      }

      setProg({ pct: 98, msg: "Building report…" });
      await wait(150);

      const uniqueAuthors = Object.keys(authorFreq).length;
      const uniqueInstitutions = Object.keys(instMap).length;

      setData({
        totalCitations: allCit.length,
        totalCitationCount: full.cited_by_count || allCit.length,
        uniqueAuthors,
        uniqueInstitutions,
        timeline,
        venues,
        highlyCited: highlyCited.sort((a, b) => (b.cited_by_count || 0) - (a.cited_by_count || 0)).slice(0, 25),
        scholars: enriched.filter(a => a.hIndex > 0).sort((a, b) => b.hIndex - a.hIndex),
        institutions,
        sectors,
        truncated: allCit.length < (full.cited_by_count || 0),
      });
      setView("dashboard");
    } catch (e) {
      console.error(e);
      setErr(`Analysis failed: ${e.message}`);
      setView("results");
    }
  }, []);

  // Generate grant summary
  const summary = data && paper ? (() => {
    const parts = [];
    parts.push(`This work has been cited ${data.totalCitationCount.toLocaleString()} times by ${data.uniqueAuthors.toLocaleString()} unique authors across ${data.uniqueInstitutions.toLocaleString()} institutions.`);
    const ti = data.institutions.slice(0, 3).map(i => `${i.name} (${i.count})`);
    if (ti.length) parts.push(`Leading citing institutions include ${ti.join(", ")}.`);
    const ts = data.scholars.slice(0, 3);
    if (ts.length) parts.push(`Prominent scholars citing this work include ${ts.map(s => `${s.name} (h-index: ${s.hIndex})`).join(", ")}.`);
    if (data.highlyCited.length) parts.push(`${data.highlyCited.length} highly-cited paper${data.highlyCited.length > 1 ? "s" : ""} (100+ citations each) reference this work.`);
    const tv = data.venues.slice(0, 3).map(v => v.name);
    if (tv.length) parts.push(`Citations appear in leading venues including ${tv.join(", ")}.`);
    if (data.timeline.length >= 2) {
      const f = data.timeline[0], l = data.timeline[data.timeline.length - 1];
      parts.push(`Annual citations grew from ${f.annual} in ${f.year} to ${l.annual} in ${l.year}, demonstrating sustained and accelerating research impact.`);
    }
    return parts.join(" ");
  })() : "";

  // Helper for paper display
  const paperAuthors = (p) => {
    const auths = p.authorships?.slice(0, 3).map(a => a.author?.display_name).filter(Boolean) || [];
    const more = (p.authorships?.length || 0) > 3;
    return auths.join(", ") + (more ? " et al." : "");
  };
  const paperVenue = (p) => p.primary_location?.source?.display_name || "";
  const paperDoi = (p) => p.doi ? p.doi.replace("https://doi.org/", "") : "";

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700;900&family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        @keyframes fadeUp { from { opacity:0; transform:translateY(20px) } to { opacity:1; transform:translateY(0) } }
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:1} }
        * { box-sizing:border-box; margin:0; padding:0 }
        input:focus,button:focus { outline:none }
        ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}
        a{color:${C.blue};text-decoration:none} a:hover{text-decoration:underline}
      `}</style>

      {/* ======= LANDING ======= */}
      {view === "landing" && (
        <div style={{ position: "relative" }}>
          <div style={{ position: "fixed", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
            <div style={{ position: "absolute", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(77,142,247,0.07) 0%, transparent 70%)", top: -150, right: -100 }} />
            <div style={{ position: "absolute", width: 500, height: 500, borderRadius: "50%", background: "radial-gradient(circle, rgba(212,160,18,0.05) 0%, transparent 70%)", bottom: -100, left: -80 }} />
          </div>
          <nav style={{ position: "relative", zIndex: 10, display: "flex", alignItems: "center", gap: 12, padding: "20px 36px", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 700, color: C.bg }}>C</div>
            <span style={{ fontSize: 19, fontWeight: 700, fontFamily: "'Playfair Display', serif" }}>CitationImpact</span>
            <span style={{ fontSize: 10, color: C.textMut, fontFamily: "'JetBrains Mono', monospace", marginLeft: 8, padding: "2px 8px", background: C.surfaceLight, borderRadius: 4 }}>powered by OpenAlex</span>
          </nav>
          <div style={{ position: "relative", zIndex: 1, maxWidth: 820, margin: "0 auto", padding: "80px 36px 40px", textAlign: "center" }}>
            <div style={{ animation: "fadeUp 0.7s ease both" }}>
              <div style={{ display: "inline-block", padding: "5px 14px", background: C.surfaceLight, border: `1px solid ${C.border}`, borderRadius: 999, fontSize: 11, color: C.accent, fontFamily: "'JetBrains Mono', monospace", marginBottom: 28, letterSpacing: "0.08em" }}>✦ RESEARCH IMPACT ANALYSIS</div>
              <h1 style={{ fontSize: 50, fontWeight: 900, fontFamily: "'Playfair Display', serif", lineHeight: 1.1, marginBottom: 22, letterSpacing: "-0.02em" }}>
                Know <span style={{ color: C.accent }}>who</span> cites your work.<br />Know <span style={{ color: C.blue }}>why</span> it matters.
              </h1>
              <p style={{ fontSize: 17, color: C.textSec, lineHeight: 1.7, maxWidth: 580, margin: "0 auto 36px", fontWeight: 300 }}>
                Turn raw citation counts into grant-ready impact evidence. Discover high-profile scholars, top institutions, and venue quality — automatically.
              </p>
            </div>
            <div style={{ animation: "fadeUp 0.7s ease 0.15s both", display: "flex", gap: 10, maxWidth: 620, margin: "0 auto 14px" }}>
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()}
                placeholder="Paper title, DOI, arXiv ID, or OpenAlex URL…"
                style={{ flex: 1, padding: "15px 18px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 11, color: C.text, fontSize: 14, fontFamily: "'DM Sans', sans-serif", transition: "border-color 0.2s" }}
                onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
              <button onClick={search} disabled={searching}
                style={{ padding: "15px 28px", background: searching ? C.surfaceLight : `linear-gradient(135deg, ${C.accent}, #e8c84a)`, border: "none", borderRadius: 11, color: searching ? C.textMut : C.bg, fontSize: 14, fontWeight: 600, cursor: searching ? "wait" : "pointer", fontFamily: "'DM Sans', sans-serif" }}>
                {searching ? "Searching…" : "Search"}
              </button>
            </div>
            <p style={{ fontSize: 11, color: C.textMut, fontFamily: "'JetBrains Mono', monospace" }}>Try: "Attention Is All You Need" · 10.1038/s41586-021-03819-2 · 1706.03762</p>

            <div style={{ marginTop: 14, animation: "fadeUp 0.7s ease 0.25s both" }}>
              <button onClick={() => setShowSettings(!showSettings)}
                style={{ background: "transparent", border: "none", color: C.textMut, fontSize: 11, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace", padding: "4px 8px" }}>
                ⚙ {showSettings ? "Hide" : "Settings"} {mailto ? "(email set ✓)" : ""}
              </button>
              {showSettings && (
                <div style={{ maxWidth: 480, margin: "10px auto 0", animation: "fadeIn 0.2s", textAlign: "left" }}>
                  <label style={{ fontSize: 11, color: C.textSec, fontFamily: "'JetBrains Mono', monospace", display: "block", marginBottom: 6 }}>
                    Email (optional) — enters OpenAlex "polite pool" for faster API access
                  </label>
                  <input value={mailto} onChange={e => updateMailto(e.target.value)}
                    placeholder="you@university.edu"
                    style={{ width: "100%", padding: "10px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}
                    onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
                  <p style={{ fontSize: 10, color: C.textMut, marginTop: 6, fontFamily: "'JetBrains Mono', monospace" }}>
                    OpenAlex uses this only for rate-limit prioritization — <a href="https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication" target="_blank" rel="noopener noreferrer" style={{ color: C.blue }}>learn more</a>
                  </p>
                </div>
              )}
            </div>

            {err && <div style={{ marginTop: 16, padding: "10px 16px", background: "#fb718522", border: "1px solid #fb718544", borderRadius: 8, color: C.rose, fontSize: 13 }}>{err}</div>}
          </div>
          <div style={{ maxWidth: 900, margin: "14px auto 80px", padding: "0 36px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
            {[
              { i: "📋", t: "Grant Impact Summary", d: "Copy-ready statements for proposals" },
              { i: "🏆", t: "Highly-Cited Papers", d: "100+ citation papers citing YOUR work" },
              { i: "👥", t: "Scholar Profiles", d: "h-index & affiliations of citing authors" },
              { i: "🏛️", t: "Institutions", d: "Universities, industry, government, medical" },
              { i: "📚", t: "Venue Quality", d: "Top journals & conferences ranked" },
              { i: "📈", t: "Citation Velocity", d: "Track impact trajectory over time" },
            ].map((f, i) => (
              <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13, padding: "20px 18px", animation: `fadeUp 0.5s ease ${0.25 + i * 0.06}s both`, transition: "border-color 0.2s, transform 0.2s", cursor: "default" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.transform = "translateY(-2px)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.transform = "translateY(0)"; }}>
                <div style={{ fontSize: 24, marginBottom: 10 }}>{f.i}</div>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{f.t}</div>
                <div style={{ fontSize: 12, color: C.textSec, lineHeight: 1.4 }}>{f.d}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ======= SEARCH RESULTS ======= */}
      {view === "results" && (
        <div>
          <nav style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 28px", borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 100, background: `${C.bg}ee`, backdropFilter: "blur(12px)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => { setView("landing"); setErr(""); }}>
              <div style={{ width: 28, height: 28, borderRadius: 7, background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: C.bg }}>C</div>
              <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Playfair Display', serif" }}>CitationImpact</span>
            </div>
            <div style={{ flex: 1, display: "flex", gap: 8, maxWidth: 480, marginLeft: 16 }}>
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()}
                style={{ flex: 1, padding: "9px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13 }}
                onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
              <button onClick={search} disabled={searching} style={{ padding: "9px 18px", background: C.accent, border: "none", borderRadius: 8, color: C.bg, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{searching ? "…" : "Search"}</button>
            </div>
          </nav>
          <div style={{ maxWidth: 780, margin: "28px auto", padding: "0 28px" }}>
            <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 18, fontFamily: "'Playfair Display', serif", color: C.textSec }}>
              Select a paper to analyze <span style={{ fontSize: 13, color: C.textMut, fontWeight: 400 }}>({results.length} result{results.length !== 1 ? "s" : ""})</span>
            </h2>
            {err && <div style={{ marginBottom: 14, padding: "10px 16px", background: "#fb718522", border: "1px solid #fb718544", borderRadius: 8, color: C.rose, fontSize: 13 }}>{err}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {results.map((p, i) => (
                <div key={p.id || i} onClick={() => { setErr(""); analyze(p); }}
                  style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 22px", cursor: "pointer", transition: "border-color 0.2s, transform 0.15s", animation: `fadeUp 0.4s ease ${i * 0.05}s both` }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.transform = "translateY(-1px)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.transform = "translateY(0)"; }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, lineHeight: 1.4 }}>{p.title || "Untitled"}</div>
                  <div style={{ display: "flex", gap: 14, fontSize: 12, color: C.textSec, flexWrap: "wrap", alignItems: "center" }}>
                    <span>{paperAuthors(p)}</span>
                    {p.publication_year && <span style={{ color: C.textMut }}>· {p.publication_year}</span>}
                    {paperVenue(p) && <span style={{ color: C.blue }}>· {paperVenue(p)}</span>}
                    <span style={{ color: C.accent, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{(p.cited_by_count || 0).toLocaleString()} citations</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ======= ANALYZING ======= */}
      {view === "analyzing" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 40, textAlign: "center" }}>
          <div style={{ width: 46, height: 46, borderRadius: 11, background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21, fontWeight: 700, color: C.bg, marginBottom: 26 }}>C</div>
          <h2 style={{ fontSize: 21, fontWeight: 700, fontFamily: "'Playfair Display', serif", marginBottom: 8 }}>Analyzing Citations</h2>
          <p style={{ fontSize: 13, color: C.textSec, marginBottom: 30, maxWidth: 400, lineHeight: 1.5 }}>{paper?.title}</p>
          <div style={{ width: 380, maxWidth: "90%", marginBottom: 14 }}>
            <div style={{ width: "100%", height: 5, background: C.surface, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${prog.pct}%`, height: "100%", background: `linear-gradient(90deg, ${C.accent}, ${C.blue})`, borderRadius: 3, transition: "width 0.4s ease" }} />
            </div>
          </div>
          <p style={{ fontSize: 12, color: C.textMut, fontFamily: "'JetBrains Mono', monospace", animation: "pulse 1.5s infinite" }}>{prog.msg}</p>
          <button onClick={() => { abort.current = true; setView("landing"); }}
            style={{ marginTop: 26, padding: "7px 18px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 7, color: C.textMut, fontSize: 12, cursor: "pointer" }}>Cancel</button>
        </div>
      )}

      {/* ======= DASHBOARD ======= */}
      {view === "dashboard" && data && (
        <div>
          <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 24px", borderBottom: `1px solid ${C.border}`, background: `${C.bg}ee`, backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 100 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => setView("landing")}>
              <div style={{ width: 26, height: 26, borderRadius: 6, background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: C.bg }}>C</div>
              <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Playfair Display', serif" }}>CitationImpact</span>
            </div>
            <div style={{ flex: 1, maxWidth: 400, margin: "0 14px", padding: "6px 12px", background: C.surface, borderRadius: 7, border: `1px solid ${C.border}`, fontSize: 11, color: C.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <span style={{ color: C.accent, marginRight: 6 }}>⬡</span>{paper?.title}
            </div>
            <button onClick={() => setView("landing")} style={{ padding: "6px 14px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSec, fontSize: 11, cursor: "pointer" }}>← New Analysis</button>
          </nav>

          <div style={{ maxWidth: 1060, margin: "0 auto", padding: "24px 24px 80px" }}>
            {data.truncated && (
              <div style={{ marginBottom: 14, padding: "8px 14px", background: `${C.accent}11`, border: `1px solid ${C.accent}33`, borderRadius: 8, fontSize: 11, color: C.accent, fontFamily: "'JetBrains Mono', monospace" }}>
                ⚠ Paper has {data.totalCitationCount.toLocaleString()} total citations — analysis covers {data.totalCitations.toLocaleString()}.
              </div>
            )}

            <div style={{ display: "flex", gap: 3, marginBottom: 24, background: C.surface, borderRadius: 9, padding: 3, border: `1px solid ${C.border}`, width: "fit-content", flexWrap: "wrap" }}>
              {[["overview", "Overview"], ["papers", "Highly-Cited"], ["scholars", "Scholars"], ["institutions", "Institutions"], ["venues", "Venues"]].map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)} style={{
                  padding: "8px 16px", background: tab === id ? C.surfaceLight : "transparent",
                  border: tab === id ? `1px solid ${C.border}` : "1px solid transparent",
                  borderRadius: 7, color: tab === id ? C.text : C.textMut, fontSize: 12, fontWeight: tab === id ? 600 : 400, cursor: "pointer"
                }}>{label}</button>
              ))}
            </div>

            {/* ---- OVERVIEW ---- */}
            {tab === "overview" && (
              <div style={{ animation: "fadeIn 0.3s" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
                  {[
                    { l: "Total Citations", v: data.totalCitationCount, i: "📊" },
                    { l: "Unique Authors", v: data.uniqueAuthors, i: "👥" },
                    { l: "Institutions", v: data.uniqueInstitutions, i: "🏛️" },
                    { l: "100+ Cited", v: data.highlyCited.length, i: "🏆" },
                  ].map((s, i) => (
                    <div key={i} style={{ background: `linear-gradient(135deg, ${C.surface}, ${C.surfaceLight})`, border: `1px solid ${C.border}`, borderRadius: 13, padding: "18px 20px", animation: `fadeUp 0.4s ease ${i * 0.05}s both` }}>
                      <div style={{ fontSize: 11, color: C.textMut, marginBottom: 5, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.i} {s.l}</div>
                      <div style={{ fontSize: 30, fontWeight: 700, fontFamily: "'Playfair Display', serif" }}>{s.v.toLocaleString()}</div>
                    </div>
                  ))}
                </div>

                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13, padding: 22, marginBottom: 20 }}>
                  <Hdr sub="Copy-ready for your next proposal">📋 Grant Impact Summary</Hdr>
                  <div style={{ background: C.bg, borderRadius: 9, padding: 18, border: `1px solid ${C.border}`, position: "relative" }}>
                    <p style={{ fontSize: 13, lineHeight: 1.8, color: C.textSec, paddingRight: 60 }}>{summary}</p>
                    <button onClick={() => navigator.clipboard?.writeText(summary)}
                      style={{ position: "absolute", top: 10, right: 10, padding: "5px 11px", background: C.surfaceLight, border: `1px solid ${C.border}`, borderRadius: 5, color: C.textMut, fontSize: 10, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>Copy ⎘</button>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: data.sectors.length ? "5fr 3fr" : "1fr", gap: 16, marginBottom: 20 }}>
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13, padding: 22 }}>
                    <Hdr sub="Annual citations per year">📈 Citation Velocity</Hdr>
                    {data.timeline.length > 1 ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <AreaChart data={data.timeline}>
                          <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.blue} stopOpacity={0.3} /><stop offset="100%" stopColor={C.blue} stopOpacity={0} /></linearGradient></defs>
                          <XAxis dataKey="year" tick={{ fill: C.textMut, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }} axisLine={{ stroke: C.border }} tickLine={false} />
                          <YAxis tick={{ fill: C.textMut, fontSize: 11 }} axisLine={false} tickLine={false} />
                          <Tooltip content={<TT />} />
                          <Area type="monotone" dataKey="annual" stroke={C.blue} strokeWidth={2} fill="url(#ag)" dot={{ fill: C.blue, r: 3, strokeWidth: 0 }} name="Annual Citations" />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : <p style={{ color: C.textMut, fontSize: 13, padding: 20 }}>Not enough data to plot.</p>}
                  </div>

                  {data.sectors.length > 0 && (
                    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13, padding: 22 }}>
                      <Hdr sub="From citing author affiliations">🏛️ Sector Breakdown</Hdr>
                      <ResponsiveContainer width="100%" height={150}>
                        <PieChart><Pie data={data.sectors} cx="50%" cy="50%" innerRadius={38} outerRadius={62} paddingAngle={3} dataKey="value" stroke="none">
                          {data.sectors.map((s, i) => <Cell key={i} fill={sectorColor(s.name)} />)}
                        </Pie><Tooltip content={<TT />} /></PieChart>
                      </ResponsiveContainer>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginTop: 4 }}>
                        {data.sectors.map((s, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: C.textSec }}>
                            <div style={{ width: 7, height: 7, borderRadius: 2, background: sectorColor(s.name) }} />{s.name} ({s.value})
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {data.venues.length > 0 && (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13, padding: 22 }}>
                    <Hdr sub="Most frequent citation venues">📚 Top Venues</Hdr>
                    <ResponsiveContainer width="100%" height={Math.max(180, data.venues.slice(0, 10).length * 30)}>
                      <BarChart data={data.venues.slice(0, 10)} layout="vertical" margin={{ left: 8 }}>
                        <XAxis type="number" tick={{ fill: C.textMut, fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis type="category" dataKey="name" tick={{ fill: C.textSec, fontSize: 11 }} axisLine={false} tickLine={false} width={200} />
                        <Tooltip content={<TT />} />
                        <Bar dataKey="count" name="Citing Papers" radius={[0, 5, 5, 0]} barSize={15} fill={C.blue} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}

            {/* ---- HIGHLY CITED ---- */}
            {tab === "papers" && (
              <div style={{ animation: "fadeIn 0.3s" }}>
                <Hdr sub={`${data.highlyCited.length} papers with 100+ citations that cite this work`}>🏆 Highly-Cited Citing Papers</Hdr>
                {data.highlyCited.length === 0 ? (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: "center", color: C.textMut, fontSize: 13 }}>No citing papers with 100+ citations found.</div>
                ) : data.highlyCited.map((p, i) => (
                  <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 20px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center", animation: `fadeUp 0.4s ease ${i * 0.03}s both`, transition: "border-color 0.2s" }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = C.accent} onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5, lineHeight: 1.4 }}>
                        {p.doi ? <a href={p.doi} target="_blank" rel="noopener noreferrer">{p.title || "Untitled"}</a> : (p.title || "Untitled")}
                      </div>
                      <div style={{ fontSize: 12, color: C.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {paperAuthors(p)}
                        {p.publication_year ? ` · ${p.publication_year}` : ""}
                        {paperVenue(p) ? <span style={{ color: C.blue }}> · {paperVenue(p)}</span> : ""}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", marginLeft: 14, flexShrink: 0 }}>
                      <div style={{ fontSize: 22, fontWeight: 700, color: C.accent, fontFamily: "'Playfair Display', serif" }}>{(p.cited_by_count || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 9, color: C.textMut, fontFamily: "'JetBrains Mono', monospace" }}>CITATIONS</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ---- SCHOLARS ---- */}
            {tab === "scholars" && (
              <div style={{ animation: "fadeIn 0.3s" }}>
                <Hdr sub="Top citing authors enriched with h-index from OpenAlex">👥 High-Profile Scholars</Hdr>
                {data.scholars.length === 0 ? (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: "center", color: C.textMut, fontSize: 13 }}>No enriched author profiles available.</div>
                ) : (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
                      <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                        {["Scholar", "h-index", "Total Citations", "Affiliation", "Papers Citing"].map(h => (
                          <th key={h} style={{ padding: "11px 14px", textAlign: "left", fontSize: 10, color: C.textMut, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>{data.scholars.map((s, i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, transition: "background 0.15s" }}
                          onMouseEnter={e => e.currentTarget.style.background = C.surfaceLight} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td style={{ padding: "13px 14px" }}>
                            <a href={`https://openalex.org/${shortId(s.id)}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</a>
                          </td>
                          <td style={{ padding: "13px 14px" }}><span style={{ background: C.accentDim, color: C.accent, padding: "3px 8px", borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{s.hIndex}</span></td>
                          <td style={{ padding: "13px 14px", fontSize: 12, color: C.textSec, fontFamily: "'JetBrains Mono', monospace" }}>{s.citationCount.toLocaleString()}</td>
                          <td style={{ padding: "13px 14px", fontSize: 12, color: C.textSec, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.affiliation}</td>
                          <td style={{ padding: "13px 14px", fontSize: 13, fontWeight: 600, color: C.emerald }}>{s.citingCount}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ---- INSTITUTIONS ---- */}
            {tab === "institutions" && (
              <div style={{ animation: "fadeIn 0.3s" }}>
                <Hdr sub={`${data.uniqueInstitutions} institutions — top ${data.institutions.length} shown`}>🏛️ Citing Institutions</Hdr>
                {data.institutions.length === 0 ? (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: "center", color: C.textMut, fontSize: 13 }}>No institution data available.</div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
                    {data.institutions.map((inst, i) => {
                      const sc = sectorColor(inst.sector);
                      return (
                        <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", animation: `fadeUp 0.4s ease ${i * 0.04}s both` }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inst.name}</span>
                              <span style={{ padding: "2px 6px", borderRadius: 3, fontSize: 9, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", background: `${sc}22`, color: sc, flexShrink: 0 }}>{inst.sector.toUpperCase()}</span>
                            </div>
                            {inst.country && <div style={{ fontSize: 10, color: C.textMut, fontFamily: "'JetBrains Mono', monospace" }}>{inst.country}</div>}
                          </div>
                          <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Playfair Display', serif" }}>{inst.count}</div>
                            <div style={{ fontSize: 9, color: C.textMut, fontFamily: "'JetBrains Mono', monospace" }}>AUTHORS</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ---- VENUES ---- */}
            {tab === "venues" && (
              <div style={{ animation: "fadeIn 0.3s" }}>
                <Hdr sub="All venues where citing papers were published">📚 Citation Venues</Hdr>
                {data.venues.length === 0 ? (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: "center", color: C.textMut, fontSize: 13 }}>No venue data available.</div>
                ) : (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 400 }}>
                      <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                        {["Venue", "Citing Papers"].map(h => (
                          <th key={h} style={{ padding: "11px 14px", textAlign: "left", fontSize: 10, color: C.textMut, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>{data.venues.map((v, i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, transition: "background 0.15s" }}
                          onMouseEnter={e => e.currentTarget.style.background = C.surfaceLight} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td style={{ padding: "13px 14px", fontSize: 13, fontWeight: 500 }}>{v.name}</td>
                          <td style={{ padding: "13px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <div style={{ width: Math.max(4, Math.min(180, (v.count / data.venues[0].count) * 180)), height: 5, background: C.blue, borderRadius: 3 }} />
                              <span style={{ fontSize: 12, fontWeight: 600, color: C.accent, fontFamily: "'JetBrains Mono', monospace" }}>{v.count}</span>
                            </div>
                          </td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
