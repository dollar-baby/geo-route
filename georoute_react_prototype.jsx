// GeoRoute React Prototype
// Single-file React app (src/App.jsx) plus README and supporting notes.

/*
Instructions:
- This is a single-file React component (App.jsx) intended for a Create React App or Vite project.
- It uses CesiumJS via CDN (no API key required for the OpenStreetMap imagery provider).
- To run locally:
  1. Create a React project (recommended: Vite or Create React App).
  2. Add this file as src/App.jsx and replace the project's App.jsx.
  3. Add the provided index.html snippet to public/index.html (includes Cesium CDN script and CSS).
  4. npm install (or yarn)
  5. npm run dev / npm start

What this prototype does:
- Displays a 3D globe using Cesium with OpenStreetMap imagery (real map imagery, globe is 3D).
- Lets the user enter "From" and "To" addresses (geocoding is simulated; you may click on the map to place points).
- Simulates a load balancer (round-robin) forwarding requests to three regional servers.
- Each server has its own simplified graph (mocked) and runs Dijkstra's algorithm to compute shortest path.
- The chosen server returns the route; the route is drawn on the globe and a response log is shown.
- Interactive controls: place points by clicking, auto-detect (uses browser geolocation), simulate network latency and failures.

Notes & limitations:
- This is a front-end simulation only. No real backend or real routing API calls are made.
- The map imagery is real (OpenStreetMap tiles). For high-volume or production use, use a proper tiles provider and attribution.

---- START OF APP.JSX ----

import React, { useEffect, useRef, useState } from 'react';

// Helper: simple priority queue for Dijkstra
class MinHeap {
  constructor() { this.heap = [] }
  push(item) { this.heap.push(item); this._bubbleUp(this.heap.length-1) }
  pop() {
    if (!this.heap.length) return null;
    const top = this.heap[0];
    const end = this.heap.pop();
    if (this.heap.length) { this.heap[0] = end; this._sinkDown(0) }
    return top;
  }
  _bubbleUp(n) {
    const heap = this.heap; const el = heap[n];
    while (n>0) {
      const parentN = Math.floor((n+1)/2)-1;
      const parent = heap[parentN];
      if (el[0] >= parent[0]) break;
      heap[parentN] = el; heap[n] = parent; n = parentN;
    }
  }
  _sinkDown(n) {
    const heap = this.heap; const length = heap.length; const el = heap[n];
    while (true) {
      const child2N = (n+1)*2; const child1N = child2N-1;
      let swap = null;
      if (child1N < length) {
        const child1 = heap[child1N];
        if (child1[0] < el[0]) swap = child1N;
      }
      if (child2N < length) {
        const child2 = heap[child2N];
        if ((swap === null ? el[0] : heap[child1N][0]) > child2[0]) swap = child2N;
      }
      if (swap === null) break;
      heap[n] = heap[swap]; heap[swap] = el; n = swap;
    }
  }
}

// Dijkstra implementation on a simple graph
function dijkstra(graph, src, dst) {
  // graph: { nodeId: [{to, cost, coords}], ... }
  const dist = {}; const prev = {};
  const pq = new MinHeap();
  Object.keys(graph).forEach(n => { dist[n] = Infinity; prev[n] = null });
  dist[src] = 0; pq.push([0, src]);
  while (true) {
    const item = pq.pop(); if (!item) break;
    const [d,u] = item; if (d>dist[u]) continue;
    if (u === dst) break;
    for (const edge of graph[u]) {
      const v = edge.to; const alt = d + edge.cost;
      if (alt < dist[v]) { dist[v] = alt; prev[v] = u; pq.push([alt, v]) }
    }
  }
  if (dist[dst] === Infinity) return null;
  const path = []; let u = dst; while (u) { path.unshift(u); u = prev[u] }
  return { path, distance: dist[dst] };
}

// Mock regional graphs (each server has a slightly different graph)
const REGIONAL_GRAPHS = [
  // Server 1: simple grid-like graph
  {
    A: [{to:'B', cost:1},{to:'C', cost:2}],
    B: [{to:'A',cost:1},{to:'D',cost:2}],
    C: [{to:'A',cost:2},{to:'F',cost:3}],
    D: [{to:'B',cost:2},{to:'E',cost:2}],
    E: [{to:'D',cost:2},{to:'G',cost:3}],
    F: [{to:'C',cost:3},{to:'G',cost:1}],
    G: [{to:'F',cost:1},{to:'E',cost:3}]
  },
  // Server 2: alternate weights
  {
    A: [{to:'B', cost:1},{to:'C', cost:3}],
    B: [{to:'A',cost:1},{to:'D',cost:1}],
    C: [{to:'A',cost:3},{to:'F',cost:2}],
    D: [{to:'B',cost:1},{to:'E',cost:4}],
    E: [{to:'D',cost:4},{to:'G',cost:1}],
    F: [{to:'C',cost:2},{to:'G',cost:2}],
    G: [{to:'F',cost:2},{to:'E',cost:1}]
  },
  // Server 3: different topology
  {
    A: [{to:'C', cost:2}],
    C: [{to:'A',cost:2},{to:'F',cost:2}],
    F: [{to:'C',cost:2},{to:'G',cost:1}],
    G: [{to:'F',cost:1}],
    // isolated nodes
    B: [{to:'D',cost:2}], D:[{to:'B',cost:2}], E:[]
  }
];

// Utility: simple lat/lng mapping for nodes (to draw on map)
const NODE_COORDS = {
  A: {lat: -33.9249, lon: 18.4241}, // Cape Town
  B: {lat: -26.2041, lon: 28.0473}, // Johannesburg
  C: {lat: -29.8579, lon: 31.0292}, // Durban
  D: {lat: -25.7461, lon: 28.1881}, // Pretoria
  E: {lat: -33.4608, lon: 22.9375}, // Mossel Bay
  F: {lat: -30.5595, lon: 22.9375}, // Eastern point (example)
  G: {lat: -34.0, lon: 25.0}
};

export default function App() {
  const viewerRef = useRef(null);
  const cesiumContainerRef = useRef(null);
  const [logs, setLogs] = useState([]);
  const [roundRobinState, setRoundRobinState] = useState(0);
  const [fromNode, setFromNode] = useState('A');
  const [toNode, setToNode] = useState('G');
  const [autoDetectEnabled, setAutoDetectEnabled] = useState(false);
  const [simLatency, setSimLatency] = useState(500);
  const [simulateFailureRate, setSimFailureRate] = useState(0);

  useEffect(() => {
    // Initialize Cesium viewer from global Cesium object (loaded via CDN in index.html)
    if (!window.Cesium) { console.error('Cesium not loaded'); return }
    const Cesium = window.Cesium;
    // clean up existing
    if (viewerRef.current) { try { viewerRef.current.destroy(); } catch(e){} }
    const viewer = new Cesium.Viewer(cesiumContainerRef.current, {
      imageryProvider: new Cesium.OpenStreetMapImageryProvider(),
      baseLayerPicker: false,
      timeline: false,
      animation: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(), // flat terrain but 3D globe
    });
    viewerRef.current = viewer;

    // Add node markers
    const entities = viewer.entities;
    Object.entries(NODE_COORDS).forEach(([id, c]) => {
      entities.add({
        id: 'node-'+id,
        position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 100),
        label: { text: id, pixelOffset: new Cesium.Cartesian2(0,-20), scale:1.2 },
        point: { pixelSize: 8 }
      });
    });

    // Click to set From/To
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(function(click) {
      const picked = viewer.scene.pick(click.position);
      if (Cesium.defined(picked) && picked.id && picked.id.id && picked.id.id.startsWith('node-')) {
        const nodeId = picked.id.id.slice(5);
        // toggle: first click sets From, second sets To
        if (!fromNode || (fromNode && toNode)) { setFromNode(nodeId); setToNode(null); addLog(`Selected FROM ${nodeId} by click`) }
        else { setToNode(nodeId); addLog(`Selected TO ${nodeId} by click`) }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    return () => { handler.destroy(); try { viewer.destroy(); } catch(e){} }
  }, []); // run once

  useEffect(() => {
    // Draw selected points and route if available
    const viewer = viewerRef.current; if (!viewer) return;
    // clear previous selection entities
    viewer.entities.removeAll();
    // re-add nodes
    Object.entries(NODE_COORDS).forEach(([id, c]) => viewer.entities.add({
      id: 'node-'+id,
      position: window.Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 100),
      label: { text: id, pixelOffset: new window.Cesium.Cartesian2(0,-20) },
      point: { pixelSize: 8 }
    }));

    if (fromNode) {
      const c = NODE_COORDS[fromNode]; viewer.entities.add({ id:'from', position: window.Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 200), point:{pixelSize:12, color: window.Cesium.Color.GREEN}, label:{text:'FROM:'+fromNode}})
    }
    if (toNode) {
      const c = NODE_COORDS[toNode]; viewer.entities.add({ id:'to', position: window.Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 200), point:{pixelSize:12, color: window.Cesium.Color.RED}, label:{text:'TO:'+toNode}})
    }
  }, [fromNode, toNode]);

  function addLog(text) {
    const t = new Date().toISOString(); setLogs(l => [{t, text}, ...l].slice(0,50));
  }

  async function submitRequest() {
    if (!fromNode || !toNode) { addLog('Select both FROM and TO nodes before submitting.'); return }
    // Load balancer round robin
    const serverIndex = roundRobinState % 3; setRoundRobinState(s => s+1);
    addLog(`Load Balancer: forwarding request to Server ${serverIndex+1}`);

    // simulate latency and failure
    const willFail = Math.random() < simulateFailureRate;
    await new Promise(r => setTimeout(r, simLatency + Math.random()*300));
    if (willFail) {
      addLog(`Server ${serverIndex+1} failed to respond (simulated).`);
      return;
    }

    // Server computes route using its graph
    const graph = REGIONAL_GRAPHS[serverIndex];
    const result = dijkstra(graph, fromNode, toNode);
    if (!result) { addLog(`Server ${serverIndex+1}: No route found between ${fromNode} and ${toNode}.`); return }
    addLog(`Server ${serverIndex+1}: Route found ${result.path.join(' -> ')} (distance ${result.distance})`);

    // Draw route on globe
    const viewer = viewerRef.current; if (!viewer) return;
    const positions = result.path.map(n => {
      const c = NODE_COORDS[n]; return window.Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 150);
    });
    viewer.entities.add({ id: 'route', polyline: { positions, width: 4, material: window.Cesium.Color.CYAN } });
    // zoom to route
    viewer.zoomTo(viewer.entities.getById('route')).otherwise(() => {});
  }

  function handleAutoDetect() {
    if (!navigator.geolocation) { addLog('Geolocation not available'); return }
    navigator.geolocation.getCurrentPosition(pos => {
      addLog('Auto-detect succeeded (simulated). Setting FROM to nearest node.');
      // find nearest node by haversine
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      let best = null, bestd = Infinity; for (const [id,c] of Object.entries(NODE_COORDS)) {
        const d = Math.hypot((lat-c.lat), (lon-c.lon)); if (d < bestd) { bestd = d; best = id }
      }
      setFromNode(best); addLog('Auto-selected FROM: '+best);
    }, err => addLog('Geolocation failed: '+err.message));
  }

  return (
    <div style={{display:'flex', height:'100vh', fontFamily:'system-ui, Arial'}}>
      <div style={{width:360, padding:16, boxSizing:'border-box', background:'#0f172a', color:'#fff', overflow:'auto'}}>
        <h2 style={{marginTop:0}}>GeoRoute — Interactive Prototype</h2>
        <p>Simulates a distributed routing system with a 3D globe.</p>
        <div style={{marginTop:12}}>
          <label>FROM (node id)</label>
          <input value={fromNode || ''} onChange={e=>setFromNode(e.target.value.toUpperCase())} style={{width:'100%', padding:8, marginTop:4}} />
        </div>
        <div style={{marginTop:8}}>
          <label>TO (node id)</label>
          <input value={toNode || ''} onChange={e=>setToNode(e.target.value.toUpperCase())} style={{width:'100%', padding:8, marginTop:4}} />
        </div>
        <div style={{display:'flex', gap:8, marginTop:8}}>
          <button onClick={()=>{setFromNode('A'); setToNode('G'); addLog('Preset A->G loaded')}} style={{flex:1, padding:8}}>Load A→G</button>
          <button onClick={handleAutoDetect} style={{flex:1, padding:8}}>AUTO</button>
        </div>
        <div style={{marginTop:12}}>
          <label>Simulated latency (ms): {simLatency}</label>
          <input type='range' min='0' max='3000' value={simLatency} onChange={e=>setSimLatency(Number(e.target.value))} style={{width:'100%'}} />
          <label>Simulated failure rate: {(simulateFailureRate*100).toFixed(0)}%</label>
          <input type='range' min='0' max='0.9' step='0.05' value={simulateFailureRate} onChange={e=>setSimFailureRate(Number(e.target.value))} style={{width:'100%'}} />
        </div>
        <div style={{marginTop:12, display:'flex', gap:8}}>
          <button onClick={submitRequest} style={{flex:1, padding:12, background:'#06b6d4', border:'none'}}>Submit Request</button>
          <button onClick={()=>{ setLogs([]); const v=viewerRef.current; if (v) v.entities.removeAll(); addLog('Cleared map and logs.'); }} style={{flex:1, padding:12}}>Clear</button>
        </div>

        <div style={{marginTop:16}}>
          <h3 style={{marginBottom:8}}>Activity Log</h3>
          <div style={{maxHeight:280, overflow:'auto', background:'#071024', padding:8, borderRadius:6}}>
            {logs.map((l,i)=> (
              <div key={i} style={{padding:6, borderBottom:'1px solid #07233a'}}><strong style={{color:'#9be7ff'}}>[{l.t.split('T')[1].split('.')[0]}]</strong> {l.text}</div>
            ))}
          </div>
        </div>

        <div style={{marginTop:12}}>
          <h4>How it works</h4>
          <ol>
            <li>User selects FROM and TO nodes (click map or type node id).</li>
            <li>Load balancer forwards request to Server 1..3 using round-robin.</li>
            <li>Server runs Dijkstra on its local graph and returns a route.</li>
            <li>Route is drawn on the 3D globe and logged.</li>
          </ol>
        </div>

      </div>
      <div style={{flex:1, position:'relative'}}>
        <div ref={cesiumContainerRef} style={{width:'100%', height:'100%'}} />
      </div>
    </div>
  );
}

---- END OF APP.JSX ----


--- public/index.html snippet (required) ---

<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GeoRoute Prototype</title>
    <!-- CesiumJS via CDN -->
    <link href="https://cesium.com/downloads/cesiumjs/releases/1.119/Build/Cesium/Widgets/widgets.css" rel="stylesheet">
    <script src="https://cesium.com/downloads/cesiumjs/releases/1.119/Build/Cesium/Cesium.js"></script>
    <style>html,body,#root{height:100%;margin:0;padding:0}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>


--- package.json (suggested) ---
{
  "name": "georoute-prototype",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "vite": "^5.0.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}


--- src/main.jsx (for Vite) ---
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
createRoot(document.getElementById('root')).render(<App />)


--- README / Deployment notes ---
1. Create a new Vite React project or drop these files into an existing project.
2. Ensure public/index.html includes the Cesium CDN links shown above.
3. npm install && npm run dev to test locally.
4. To deploy to GitHub Pages or Netlify, build (npm run build) and follow the host's static site deployment instructions.

Credits & Attributions:
- Map imagery: OpenStreetMap tiles (via Cesium OpenStreetMapImageryProvider). For production use, please follow OSM tile usage policy and consider a tile provider.
- CesiumJS: used for 3D globe rendering (CDN link included).


---- End of document ----
