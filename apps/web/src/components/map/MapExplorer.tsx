'use client';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Map as MlMap, Marker, Popup, LngLatBounds, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapData, MapPin, MediaItem } from '@/lib/types';
import { MAP_STYLE_DARK, MAP_STYLE_LIGHT } from '@/lib/config';
import { useMediaUrls } from '@/lib/urls';
import { useFormat } from '@/lib/format';
import { AvatarStack } from '../Avatar';
import { Thumb } from '../Thumb';
import { MediaViewer } from '../MediaViewer';
import { usePeopleIndex } from '../indexes';
import { TimeScrubber, type Range } from './TimeScrubber';

// The worker is served from public/ (scripts/copy-maplibre.mjs); the bundler cannot resolve MapLibre's own worker URL.
setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

type Cluster = { key: string; lat: number; lon: number; pins: MapPin[]; rep: MapPin };
const CELL = 64;
const NORWAY: [number, number] = [10.75, 59.91];

/**
 * The map: events as round photo pins that gather into stacks as you zoom out, loose photos as small dots,
 * a time scrubber along the bottom and the events in view listed on the side.
 */
export function MapExplorer({ data }: { data: MapData }) {
  const t = useTranslations('map');
  const fmt = useFormat();
  const people = usePeopleIndex();
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);  // why the map never started, if it did not
  const [tick, setTick] = useState(0);              // bumps on every map move
  const [styleTick, setStyleTick] = useState(0);    // bumps when the base style is swapped (light ↔ dark)
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [showLoose, setShowLoose] = useState(true);
  const [viewer, setViewer] = useState<{ items: MediaItem[]; i: number } | null>(null);
  const markers = useRef(new Map<string, { marker: Marker; el: HTMLElement }>());
  const popup = useRef<{ popup: Popup; el: HTMLElement; id: string } | null>(null);

  const times = useMemo(() => [...data.items.map((p) => new Date(p.startAt).getTime()), ...data.loose.map((m) => (m.capturedAt ? new Date(m.capturedAt).getTime() : NaN)).filter((x) => !Number.isNaN(x))], [data]);
  const min = useMemo(() => (times.length ? Math.min(...times) : Date.now() - 365 * 86_400_000), [times]);
  const max = useMemo(() => (times.length ? Math.max(...times) + 86_400_000 : Date.now()), [times]);
  const [range, setRange] = useState<Range>({ from: min, to: max });
  useEffect(() => { setRange({ from: min, to: max }); }, [min, max]);
  const pins = useMemo(() => data.items.filter((p) => { const s = new Date(p.startAt).getTime(), e = new Date(p.endAt).getTime(); return e >= range.from && s <= range.to; }), [data.items, range]);
  const loose = useMemo(() => data.loose.filter((m) => { const x = m.capturedAt ? new Date(m.capturedAt).getTime() : NaN; return x >= range.from && x <= range.to; }), [data.loose, range]);

  // --- map bootstrap -------------------------------------------------------------------------------------------
  useEffect(() => {
    const el = box.current; if (!el || mapRef.current) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    let map: MlMap;
    try {
      map = new MlMap({ container: el, style: dark.matches ? MAP_STYLE_DARK : MAP_STYLE_LIGHT, center: NORWAY, zoom: 4, attributionControl: { compact: true }, fadeDuration: 150 });
    } catch (e) {
      console.error('map: could not start', e);
      setFailure(e instanceof Error ? e.message : String(e));
      return;
    }
    let loaded = false;
    map.on('error', (e) => {
      console.error('map:', e.error);
      if (!loaded) setFailure(e.error?.message ?? String(e.error)); // a broken style; tile hiccups after load are not fatal
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-left');
    map.addControl(new ScaleControl({ maxWidth: 80 }), 'bottom-left');
    mapRef.current = map;
    const ensureLayers = () => {
      if (map.getSource('loose')) return;
      map.addSource('loose', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4a3fb0';
      map.addLayer({ id: 'loose-dots', type: 'circle', source: 'loose', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 12, 5, 16, 7], 'circle-color': accent, 'circle-opacity': 0.8, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2 } });
      map.on('mouseenter', 'loose-dots', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'loose-dots', () => { map.getCanvas().style.cursor = ''; });
    };
    // style.load is enough for sources, markers and the first fit; 'load' would wait for every tile of the first view
    map.on('style.load', () => { loaded = true; setFailure(null); ensureLayers(); setStyleTick((n) => n + 1); setReady(true); });
    map.on('move', () => setTick((n) => n + 1));
    map.on('click', () => setSelected(null));
    const onScheme = (e: MediaQueryListEvent) => map.setStyle(e.matches ? MAP_STYLE_DARK : MAP_STYLE_LIGHT);
    dark.addEventListener('change', onScheme);
    return () => { dark.removeEventListener('change', onScheme); map.remove(); mapRef.current = null; };
  }, []);

  // first fit: everything with a location
  const fitted = useRef(false);
  const fitAll = useCallback((animate = true) => {
    const map = mapRef.current; if (!map) return;
    const pts: Array<[number, number]> = [...pins.map((p) => [p.lon, p.lat] as [number, number]), ...loose.map((m) => [m.lon!, m.lat!] as [number, number])];
    if (!pts.length) return;
    const b = pts.reduce((bb, p) => bb.extend(p), new LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: { top: 70, bottom: 140, left: 60, right: 60 }, maxZoom: 14, duration: animate ? 700 : 0 });
  }, [pins, loose]);
  useEffect(() => { if (ready && !fitted.current && (pins.length || loose.length)) { fitted.current = true; fitAll(false); } }, [ready, pins.length, loose.length, fitAll]);

  // loose dots follow the time range
  useEffect(() => {
    const map = mapRef.current; if (!map || !ready) return;
    const src = map.getSource('loose') as GeoJSONSource | undefined; if (!src) return;
    src.setData({ type: 'FeatureCollection', features: showLoose ? loose.map((m, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [m.lon!, m.lat!] }, properties: { i } })) : [] });
  }, [loose, ready, showLoose, styleTick]);
  useEffect(() => {
    const map = mapRef.current; if (!map || !ready) return;
    const h = (e: MapMouseEvent) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ['loose-dots'] })[0];
      if (!f) return;
      const i = Number(f.properties?.i);
      if (Number.isInteger(i) && loose[i]) { setViewer({ items: loose, i }); }
    };
    map.on('click', 'loose-dots', h);
    return () => { map.off('click', 'loose-dots', h); };
  }, [loose, ready]);

  // --- clustering on screen pixels ---------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current; if (!map || !ready) return;
    const cells = new Map<string, MapPin[]>();
    for (const p of pins) {
      const pt = map.project([p.lon, p.lat]);
      const k = `${Math.floor(pt.x / CELL)}:${Math.floor(pt.y / CELL)}`;
      const arr = cells.get(k); if (arr) arr.push(p); else cells.set(k, [p]);
    }
    const out: Cluster[] = [];
    for (const arr of cells.values()) {
      const rep = arr.reduce((a, b) => (b.nAssets > a.nAssets ? b : a));
      out.push({ key: arr.map((p) => p.id).sort().join(','), lat: arr.reduce((s, p) => s + p.lat, 0) / arr.length, lon: arr.reduce((s, p) => s + p.lon, 0) / arr.length, pins: arr, rep });
    }
    setClusters((prev) => (prev.length === out.length && prev.every((c, i) => c.key === out[i]!.key) ? prev : out));
  }, [pins, ready, tick]);

  // keep the DOM markers in sync with the clusters; React draws into them through portals
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const live = new Set(clusters.map((c) => c.key));
    for (const [k, m] of markers.current) if (!live.has(k)) { m.marker.remove(); markers.current.delete(k); }
    for (const c of clusters) {
      const ex = markers.current.get(c.key);
      if (ex) { ex.marker.setLngLat([c.lon, c.lat]); continue; }
      const el = document.createElement('div');
      el.className = 'mg-pin-wrap';
      const marker = new Marker({ element: el, anchor: 'center' }).setLngLat([c.lon, c.lat]).addTo(map);
      markers.current.set(c.key, { marker, el });
    }
    setPortalTick((n) => n + 1);
  }, [clusters]);
  const [, setPortalTick] = useState(0);

  // the selected event's card, anchored to its pin
  const selectedPin = selected ? data.items.find((p) => p.id === selected) ?? null : null;
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    if (popup.current && popup.current.id !== selected) { popup.current.popup.remove(); popup.current = null; }
    if (selectedPin && !popup.current) {
      const el = document.createElement('div');
      const p = new Popup({ closeButton: false, closeOnClick: false, offset: 34, maxWidth: '320px', className: 'mg-popup' }).setLngLat([selectedPin.lon, selectedPin.lat]).setDOMContent(el).addTo(map);
      popup.current = { popup: p, el, id: selectedPin.id };
      setPortalTick((n) => n + 1);
    }
  }, [selected, selectedPin]);
  useEffect(() => () => { popup.current?.popup.remove(); }, []);

  const covers = useMemo(() => clusters.flatMap((c) => (c.rep.coverBlobId ? [{ blobId: c.rep.coverBlobId, kind: 'thumb' as const }] : [])), [clusters]);
  const urls = useMediaUrls(covers);

  const onCluster = (c: Cluster) => {
    const map = mapRef.current; if (!map) return;
    if (c.pins.length === 1) { setSelected(c.rep.id); return; }
    const b = c.pins.reduce((bb, p) => bb.extend([p.lon, p.lat]), new LngLatBounds([c.pins[0]!.lon, c.pins[0]!.lat], [c.pins[0]!.lon, c.pins[0]!.lat]));
    const same = c.pins.every((p) => Math.abs(p.lat - c.pins[0]!.lat) < 1e-5 && Math.abs(p.lon - c.pins[0]!.lon) < 1e-5);
    if (same || map.getZoom() >= 17) { setSelected(c.rep.id); return; }
    map.fitBounds(b, { padding: 90, maxZoom: 17, duration: 500 });
  };
  const goTo = (p: MapPin) => {
    const map = mapRef.current; if (!map) return;
    setSelected(p.id);
    map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 13), duration: 700 });
  };

  // events inside the current view, for the side list
  const inView = useMemo(() => {
    const map = mapRef.current; if (!map || !ready) return pins;
    const b = map.getBounds();
    return pins.filter((p) => b.contains([p.lon, p.lat]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, ready, tick]);

  return (
    <div className="mg-map-frame">
      <div ref={box} className="mg-map" />
      {failure && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6 bg-surface/90">
          <div className="max-w-md text-center space-y-2">
            <p className="font-medium">{t('failed')}</p>
            <p className="text-ink-2 text-[13px]">{/webgl/i.test(failure) ? t('webglHint') : t('styleHint', { url: MAP_STYLE_LIGHT })}</p>
            <p className="text-ink-3 text-[12px] font-mono break-all">{failure}</p>
          </div>
        </div>
      )}

      {/* stats + actions, top-left */}
      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2 max-w-[calc(100%-1.5rem)] lg:max-w-[calc(100%-22rem)]">
        <div className="mg-pill">
          <span className="font-medium">{t('eventsWithPlace', { count: pins.length })}</span>
          {data.loose.length > 0 && <span className="text-ink-2"> · {t('loosePhotos', { count: loose.length })}</span>}
        </div>
        <button className="mg-pill hover:text-accent" onClick={() => fitAll()}>{t('fitAll')}</button>
        {data.loose.length > 0 && (
          <label className="mg-pill cursor-pointer gap-1.5"><input type="checkbox" checked={showLoose} onChange={(e) => setShowLoose(e.target.checked)} className="accent-accent" />{t('showLoose')}</label>
        )}
      </div>

      {/* in-view list, right (desktop) */}
      <aside className="mg-panel hidden lg:flex">
        <div className="px-3 pt-2.5 pb-1.5 text-[11px] uppercase tracking-wide text-ink-3 flex items-center justify-between"><span>{t('inView')}</span><span className="tabular-nums">{inView.length}</span></div>
        <div className="overflow-y-auto flex-1 px-1.5 pb-1.5 space-y-0.5">
          {inView.length === 0 && <p className="text-ink-3 text-[13px] px-2 py-3">{t('nothingInView')}</p>}
          {inView.slice(0, 200).map((p) => (
            <button key={p.id} onClick={() => goTo(p)} onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)}
              className={`w-full flex items-center gap-2.5 p-1.5 rounded-md text-left transition-colors ${selected === p.id ? 'bg-accent-soft' : 'hover:bg-bg'}`}>
              {p.coverBlobId ? <Thumb blobId={p.coverBlobId} className="w-11 h-11 rounded-md shrink-0" /> : <div className="tile w-11 h-11 rounded-md shrink-0" />}
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium truncate">{p.title}</div>
                <div className="text-[11.5px] text-ink-3 truncate">{fmt.fmtDate(p.startAt, { day: 'numeric', month: 'short', year: 'numeric' })}{p.placeName ? ` · ${p.placeName}` : p.city ? ` · ${p.city}` : ''}</div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* in-view strip, bottom (mobile) */}
      {inView.length > 0 && (
        <div className="absolute left-0 right-0 bottom-[6.2rem] z-10 flex gap-2 overflow-x-auto px-3 pb-1 lg:hidden">
          {inView.slice(0, 40).map((p) => (
            <button key={p.id} onClick={() => goTo(p)} className={`mg-pill shrink-0 gap-2 !px-1.5 ${selected === p.id ? '!border-accent' : ''}`}>
              {p.coverBlobId && <Thumb blobId={p.coverBlobId} className="w-7 h-7 rounded-full" />}
              <span className="max-w-[9rem] truncate">{p.title}</span>
            </button>
          ))}
        </div>
      )}

      {/* time scrubber, bottom */}
      {times.length > 0 && <TimeScrubber min={min} max={max} range={range} onChange={setRange} times={times} />}

      {/* photo pins */}
      {clusters.map((c) => {
        const m = markers.current.get(c.key); if (!m) return null;
        const n = c.pins.length;
        const size = Math.round(Math.min(64, 40 + Math.log2(n) * 7));
        const url = c.rep.coverBlobId ? urls[`${c.rep.coverBlobId}:thumb`] : null;
        const isSel = c.pins.some((p) => p.id === selected), isHov = c.pins.some((p) => p.id === hover);
        return createPortal(
          <button className={`mg-pin ${isSel ? 'is-selected' : ''} ${isHov ? 'is-hover' : ''}`} style={{ width: size, height: size }} onClick={(e) => { e.stopPropagation(); onCluster(c); }}
            title={n === 1 ? c.rep.title : t('stack', { count: n })} aria-label={n === 1 ? c.rep.title : t('stack', { count: n })}>
            {url ? <img src={url} alt="" draggable={false} /> : <span className="mg-pin-empty" />}
            {n > 1 && <span className="mg-pin-n">{n}</span>}
          </button>, m.el, c.key);
      })}

      {/* selected event card */}
      {popup.current && selectedPin && popup.current.id === selectedPin.id && createPortal(
        <div className="w-[280px]">
          {selectedPin.coverBlobId && <Thumb blobId={selectedPin.coverBlobId} kind="preview" className="w-full aspect-[16/10]" />}
          <div className="p-3 space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-medium text-[14px] leading-tight">{selectedPin.title}</h3>
              <button className="text-ink-3 hover:text-ink leading-none" onClick={() => setSelected(null)} aria-label={t('close')}>×</button>
            </div>
            <div className="text-[12px] text-ink-2">{fmt.fmtSpan(selectedPin.startAt, selectedPin.endAt)}{selectedPin.placeName ? ` · ${selectedPin.placeName}` : selectedPin.city ? ` · ${selectedPin.city}` : ''}</div>
            <div className="flex items-center justify-between gap-2 text-[12px] text-ink-3">
              <span>{t('photos', { count: selectedPin.nAssets })}</span>
              <AvatarStack people={selectedPin.personIds.map((id) => ({ id, name: people.get(id)?.name ?? null }))} size={18} max={4} />
            </div>
            <Link href={`/events/${selectedPin.id}`} className="btn btn-primary w-full justify-center mt-1">{t('openEvent')}</Link>
          </div>
        </div>, popup.current.el)}

      {viewer && <MediaViewer items={viewer.items} index={viewer.i} onClose={() => setViewer(null)} onIndex={(i) => setViewer({ ...viewer, i })} />}
    </div>
  );
}
