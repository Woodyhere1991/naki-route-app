# Map-based pickup-area measurement

The customer account address editor now asks the Naki API to locate the exact
address and measure driving distance to the covered towns and roads. A postal
town alone no longer establishes free travel. Existing saved/manual choices are
retained, and editing an address clears the previous suggestion immediately.

## Coverage and method

- Town geometry: [Stats NZ Urban Rural Areas 2026, high definition](https://services2.arcgis.com/vKb0s8tBIA3bdocZ/ArcGIS/rest/services/Urban_Rural_Areas_2026/FeatureServer/0).
  New Plymouth includes Bell Block; separate official polygons cover Waitara,
  Inglewood, Stratford, Eltham, Hāwera, Ōakura, Ōkato, Ōpunake, Manaia and Kaponga.
- Existing business coverage rules are interpreted as SH3 between Hāwera and
  New Plymouth/Waitara, SH3A between Inglewood and Waitara, SH45 from New Plymouth
  through the Ōakura–Manaia coast, and Eltham Road from Ōpunake to Kaponga.
- Highway paths are derived from actual OpenStreetMap highway references, rather
  than treating every fastest-route shortcut as covered. Eltham Road includes
  its urban approach streets within the covered outlying towns.
- The bundled public graph has 49,440 nodes and 50,440 road segments. Town
  boundary intersections provide exact partial-edge access; covered highways
  provide zero-distance sources. Build-time multi-source shortest-path searches
  run backwards over directed roads, so the saved distance means driving from
  the address road to coverage, respecting mapped one-way roads.
- Runtime matches the geocoded street to a nearby named public-road segment,
  then uses its precomputed distances and boundary intersections. It makes no
  request to a public routing server. Straight-line distance is used only to
  prove an owner quote is required outside mapped coverage, never to set a fee.
- LINZ exact numbered address matches come first. Ambiguous same-number roads are
  rejected. Exact Google rooftop matches are an optional fallback where configured;
  interpolated, street-centre and OSM-geocoder guesses never establish the fee.
- Distances are estimates along the bundled mapped public roads. Private driveways,
  live closures and turn restrictions are not measured. The graph is a dated
  snapshot, not a traffic service or a surveyed distance. Unknown or distant
  street matches require confirmation.

## Pricing and safeguards

The collection minimum and existing price calculation remain unchanged: one $5
travel fee up to 5 km, one $10 fee over 5 through 10 km, and an owner quote beyond
10 km. Named outlying routes/localities retain the single $10 fee. Addresses
directly on a covered main road are free, including a mapped short driveway when
the street name/highway reference and nearby covered segment agree.

Checks within 100 m of a town edge or the 5/10 km price boundaries require manual
confirmation. Excessive map snapping, disconnected/incomplete routing, missing
addresses, lookup failures and timeouts also require a choice. Failed map lookups
never default to no fee. A measurement outside the 10 km lower-bound limit only
establishes that an owner quote is needed; it does not fabricate an exact distance.

The browser debounces typing, cancels stale checks, preserves manual changes and
offers a visible Check distance retry. Required area selection prevents submission
while an automatic suggestion is pending. The API validates Origin, rate limits
checks, hashes cache keys and caches successful checks for one day; browser
responses are no-store. No existing booking/profile/invoice is repriced.

## Data provenance and rebuilding

`worker/src/pickup-coverage.json` records the data version and sources. Town geometry
is sourced from Stats NZ and licensed under CC BY 4.0. The OpenStreetMap-derived
road/access-point database portion is available under ODbL 1.0, © OpenStreetMap
contributors. The customer editor includes source attribution.

`worker/build-pickup-coverage.mjs` builds the bundled data from public inputs in the
business root's existing ignored `tmp/` folder:

1. `pickup-urban-2026.json`: the official FeatureServer `/query`, `f=geojson`,
   `outSR=4326`, `outFields=UR2026_V1_00_NAME_ASCII`, select the towns above (Oakura's
   exact ASCII name is `Oakura (New Plymouth District)`). Preserve HD coordinates.
2. `pickup-osm-roads.json`: Overpass roads in bounding box
   `(-39.65,173.72,-38.96,174.42)` with drivable highway types; `out body; >; out skel qt;`.
   Access=no/private and service roads are excluded as coverage access points.
3. `pickup-route-inland.json`: OSRM route, driving, coordinates
   `173.858,-39.455;174.153,-39.429`, overview=full, geometries=geojson.
4. Run `node naki-route-app/worker/build-pickup-coverage.mjs` from the business root.
   Audit changed coverage and rerun tests before releasing a data refresh.

## Verification

- 252 maintained Naki Worker tests and 49 customer-site unit tests passed.
- Mobile (390 px) and desktop (1280 px) browser tests cover measured selections,
  retries, manual/saved overrides, changed addresses, late replies, boundary
  uncertainty, over-10-km quotes, layout and a single travel fee.
- Public address checks: Tikorangi School about 3.90 km ($5); Ratapiko School
  about 8.88 km ($10); Kaimata School about 7.17 km ($10); Ōakura School ($10);
  Egmont Village School directly on covered Junction Road (no fee); Rotokare
  Scenic Reserve about 12.02 km (owner quote), Makahu School (beyond 10 km).
- Final dataset version: `20261001-v2`; compressed Worker bundle about 1.56 MiB.
- Deployment/live proof is added after release. These are API/browser checks;
  no customer booking is submitted and no physical driver survey is claimed.

This release covers the website address selector. The separate Line Two phone
receptionist retains its existing locality/distance-confirmation rules.
