# vector-tile

This library reads [Mapbox Vector Tiles](https://github.com/mapbox/vector-tile-spec) and allows access to the layers and features. Depends on [pbf](https://github.com/mapbox/pbf) v5+.

## Example

```js
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';

const tile = new VectorTile(new PbfReader(data));

// Contains a map of all layers
tile.layers;

const landuse = tile.layers.landuse;

// Amount of features in this layer
landuse.length;

// Returns the first feature
landuse.feature(0);
```

Vector tiles contained in [serialtiles-spec](https://github.com/mapbox/serialtiles-spec)
are gzip-encoded, so a complete example of parsing them with the native
zlib module would be:

```js
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {gunzipSync} from 'zlib';

const buffer = gunzipSync(data);
const tile = new VectorTile(new PbfReader(buffer));
```

## Install

To install:

    npm install @mapbox/vector-tile


## API Reference

### VectorTile

An object that parses vector tile data and makes it readable.

#### Constructor

- **new VectorTile(pbf[, end])** &mdash;
  parses the vector tile data contained in the given [PbfReader](https://github.com/mapbox/pbf) object,
  saving resulting layers in the created object as a `layers` property. Optionally accepts end index.

#### Properties

- **layers** (Object) &mdash; an object containing parsed layers in the form of `{<name>: <layer>, ...}`,
where each layer is a `VectorTileLayer` object.


### VectorTileLayer

An object that contains the data for a single vector tile layer.

#### Properties

- **version** (`Number`, default: `1`)
- **name** (`String`) &mdash; layer name
- **extent** (`Number`, default: `4096`) &mdash; tile extent size
- **length** (`Number`) &mdash; number of features in the layer

#### Methods

- **feature(i)** &mdash; get a feature (`VectorTileFeature`) by the given index from the layer.


### VectorTileFeature

An object that contains the data for a single feature.

#### Properties

- **type** (`Number`) &mdash; type of the feature (also see `VectorTileFeature.types`)
- **extent** (`Number`) &mdash; feature extent size
- **id** (`Number`) &mdash; feature identifier, if present
- **properties** (`Object`) &mdash; object literal with feature properties

#### Methods

- **loadGeometry()** &mdash; parses feature geometry and returns an array of
  [Point](https://github.com/mapbox/point-geometry) arrays (with each point having `x` and `y` properties)
- **bbox()** &mdash; calculates and returns the bounding box of the feature in the form `[x1, y1, x2, y2]`
- **toGeoJSON(x, y, z[, options])** &mdash; returns a GeoJSON representation of the feature. (`x`, `y`, and `z` refer to the containing tile's index.)
  The optional `options` object supports:
  - **validate** (`Boolean`, default `false`) &mdash; strictly validate the geometry command
    sequence (MoveTo/LineTo/ClosePath pairing, points per path, coordinates within
    `[0, extent]`, polygon rings with at least three points). On failure a
    `VectorTileError` is thrown carrying `featureId`, `layer` and a human-readable
    `reason`, instead of returning a partial geometry. The default (non-validating)
    path keeps its historical lenient behavior.
  - **closeRings** (`Boolean`, default `true`) &mdash; close polygon rings automatically,
    never duplicating the first point. Set to `false` to leave rings open.
  - **normalizeWinding** (`Boolean`, default `false`) &mdash; rewind polygon rings so outer
    rings are counterclockwise and holes clockwise in tile coordinates. When enabled,
    a `MultiPolygon` never merges two outer rings into a single `Polygon`.

### VectorTileError

Thrown by `toGeoJSON` when `validate` is enabled and the feature geometry is malformed.

- **reason** (`String`) &mdash; what was wrong with the geometry
- **featureId** (`Number | undefined`) &mdash; the offending feature's id, when present
- **layer** (`String | undefined`) &mdash; the containing layer's name, when known

```js
import {VectorTileError} from '@mapbox/vector-tile';

try {
    feature.toGeoJSON(x, y, z, {validate: true});
} catch (err) {
    if (err instanceof VectorTileError) {
        // err.featureId, err.layer, err.reason
    }
}
```
