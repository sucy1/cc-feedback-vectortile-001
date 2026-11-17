import test from 'node:test';
import assert from 'node:assert/strict';
import {PbfReader, PbfWriter} from 'pbf';
import {VectorTile, VectorTileError} from '../index.js';

// Geometry commands are packed as raw varints (zig-zag encoding has already
// been applied to coordinate deltas via zz()).
const MOVE_TO = 1;
const LINE_TO = 2;
const CLOSE_PATH = 7;

/** zig-zag encode a signed coordinate delta, as pbf stores it on the wire */
function zz(n) {
    return (n << 1) ^ (n >> 31);
}

function cmd(command, count) {
    return command | (count << 3);
}

/**
 * Encode a list of polygon rings (each ring is an [x, y] vertex list, without
 * a repeated closing point) into packed geometry varints. Coordinates are
 * absolute within the tile; deltas are accumulated here so the tests stay
 * readable.
 *
 * @param {number[][][]} rings
 * @param {boolean} [close] append a ClosePath command to every ring
 * @returns {number[]}
 */
function polygonGeometry(rings, close = true) {
    const geometry = [];
    let x = 0;
    let y = 0;
    for (const ring of rings) {
        geometry.push(cmd(MOVE_TO, 1), zz(ring[0][0] - x), zz(ring[0][1] - y));
        x = ring[0][0];
        y = ring[0][1];
        geometry.push(cmd(LINE_TO, ring.length - 1));
        for (let i = 1; i < ring.length; i++) {
            geometry.push(zz(ring[i][0] - x), zz(ring[i][1] - y));
            x = ring[i][0];
            y = ring[i][1];
        }
        if (close) geometry.push(cmd(CLOSE_PATH, 1));
    }
    return geometry;
}

/**
 * Encode one or more point/lines paths into packed geometry varints.
 *
 * @param {number[][][]} paths
 * @returns {number[]}
 */
function pathGeometry(paths) {
    const geometry = [];
    let x = 0;
    let y = 0;
    for (const path of paths) {
        geometry.push(cmd(MOVE_TO, 1), zz(path[0][0] - x), zz(path[0][1] - y));
        x = path[0][0];
        y = path[0][1];
        geometry.push(cmd(LINE_TO, path.length - 1));
        for (let i = 1; i < path.length; i++) {
            geometry.push(zz(path[i][0] - x), zz(path[i][1] - y));
            x = path[i][0];
            y = path[i][1];
        }
    }
    return geometry;
}

/**
 * @param {object} opts
 * @param {number[]} [opts.geometry] packed geometry varints (already zig-zagged)
 * @param {number} [opts.type] MVT geometry type (1 point, 2 line, 3 polygon)
 * @param {boolean} [opts.emptyGeometry] emit an empty geometry field
 * @param {number} [opts.extent] layer extent
 * @param {number} [opts.id] feature id
 * @param {string} [opts.layer] layer name
 */
function buildTile({
    geometry = [],
    type = 3,
    emptyGeometry = false,
    extent = 4096,
    id = 42,
    layer = 'test'
} = {}) {
    const pbf = new PbfWriter();
    pbf.writeMessage(3, (_, p) => { // Tile.layers
        p.writeStringField(1, layer);
        p.writeMessage(2, (_, p) => { // Layer.features
            p.writeVarintField(1, id);
            p.writeVarintField(3, type);
            if (emptyGeometry) {
                // A zero-length, length-delimited geometry field (tag 4).
                p.writeMessage(4, () => {}, null);
            } else {
                p.writePackedVarint(4, geometry);
            }
        }, null);
        p.writeVarintField(5, extent);
    }, null);
    return new VectorTile(new PbfReader(pbf.finish()));
}

/**
 * @param {object} opts
 */
function featureOf(opts) {
    const layer = opts.layer ?? 'test';
    return buildTile(opts).layers[layer].feature(0);
}

/**
 * @param {() => unknown} fn
 * @param {string|RegExp} reason
 */
function assertVectorTileError(fn, reason) {
    assert.throws(fn, (err) => {
        assert.ok(err instanceof VectorTileError, 'expected a VectorTileError');
        assert.equal(err.name, 'VectorTileError');
        assert.equal(err.featureId, 42);
        assert.equal(err.layer, 'test');
        assert.equal(typeof err.reason, 'string');
        if (reason instanceof RegExp) assert.match(err.reason, reason);
        else assert.equal(err.reason, reason);
        return true;
    });
}

test('validate: an empty geometry field throws instead of returning a partial result', () => {
    const feature = featureOf({emptyGeometry: true, type: 1});
    assertVectorTileError(
        () => feature.toGeoJSON(0, 0, 0, {validate: true}),
        /empty geometry command sequence/);

    // The lenient path keeps its historical shape (empty bbox / no lines).
    assert.deepEqual(feature.bbox(), [Infinity, Infinity, -Infinity, -Infinity]);
    assert.deepEqual(feature.loadGeometry(), []);
});

test('validate: a command with a length of 0 is not silently skipped', () => {
    // MoveTo(count=0) followed by a real MoveTo(3, 4).
    const feature = featureOf({
        type: 1,
        geometry: [cmd(MOVE_TO, 0), cmd(MOVE_TO, 1), zz(3), zz(4)]
    });

    assertVectorTileError(
        () => feature.toGeoJSON(0, 0, 0, {validate: true}),
        /length of 0/);

    // Lenient parsing still skips the zero-count command (see parse.test.js).
    assert.deepEqual(feature.bbox(), [3, 4, 3, 4]);
});

test('validate: an unknown command is never drawn as a line', () => {
    // Unknown command id 4 with count 1, then a MoveTo so a lenient parser
    // would have something to misinterpret the trailing bytes as.
    const feature = featureOf({
        type: 2,
        geometry: [cmd(4, 1), zz(10), zz(20), ...pathGeometry([[[1, 1]]])]
    });

    assertVectorTileError(
        () => feature.toGeoJSON(0, 0, 0, {validate: true}),
        /unknown command 4/);
    assert.throws(() => feature.bbox(), /unknown command 4/);
    assert.throws(() => feature.loadGeometry(), /unknown command 4/);
});

test('validate: coordinates outside [0, extent] are rejected', () => {
    const feature = featureOf({
        type: 1,
        extent: 4096,
        geometry: [cmd(MOVE_TO, 1), zz(4097), zz(0)]
    });

    assertVectorTileError(
        () => feature.toGeoJSON(0, 0, 0, {validate: true}),
        /outside the tile extent/);

    // Coordinates on the extent boundary are valid.
    const boundary = featureOf({
        type: 1,
        extent: 4096,
        geometry: [cmd(MOVE_TO, 1), zz(4096), zz(0)]
    });
    assert.equal(boundary.toGeoJSON(0, 0, 0, {validate: true}).geometry.type, 'Point');
});

test('validate: an unclosed polygon ring is rejected', () => {
    // Triangle (1,1)->(2,1)->(2,2) without a ClosePath command.
    const feature = featureOf({
        type: 3,
        geometry: polygonGeometry([[[1, 1], [2, 1], [2, 2]]], false)
    });

    assertVectorTileError(
        () => feature.toGeoJSON(0, 0, 0, {validate: true}),
        /not terminated by a ClosePath/);

    // Without validation the ring is auto-closed by default and the legacy
    // three-argument call is unaffected.
    const closed = feature.toGeoJSON(0, 0, 0, {validate: false}).geometry;
    const ring = closed.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.equal(ring.length, 4); // three vertices + one closing point, no duplicate
    assert.doesNotThrow(() => feature.toGeoJSON(0, 0, 0));
});

test('validate: two outer rings become separate Polygons, never one merged Polygon', () => {
    const feature = featureOf({
        type: 3,
        geometry: polygonGeometry([
            [[1, 1], [2, 1], [2, 2]],
            [[11, 11], [12, 11], [12, 12]]
        ])
    });

    const geoJSON = feature.toGeoJSON(0, 0, 0, {validate: true}).geometry;
    assert.equal(geoJSON.type, 'MultiPolygon');
    assert.equal(geoJSON.coordinates.length, 2);
    for (const polygon of geoJSON.coordinates) {
        assert.equal(polygon.length, 1); // one outer ring each, no merged holes
    }
    assert.deepEqual(feature.bbox(), [1, 1, 12, 12]);
});

test('validate: a well-formed tile with an outer ring and a hole passes', () => {
    // Outer ring with positive signed area followed by a hole with negative
    // signed area, the opposite winding an MVT polygon is encoded with.
    const feature = featureOf({
        type: 3,
        geometry: polygonGeometry([
            [[0, 0], [10, 0], [10, 10], [0, 10]],
            [[2, 2], [2, 4], [4, 4], [4, 2]]
        ])
    });

    const geoJSON = feature.toGeoJSON(0, 0, 0, {validate: true}).geometry;
    assert.equal(geoJSON.type, 'Polygon');
    assert.equal(geoJSON.coordinates.length, 2);
    const [outerRing, holeRing] = geoJSON.coordinates;
    assert.equal(outerRing.length, 5);
    assert.equal(holeRing.length, 5);
    assert.deepEqual(outerRing[0], outerRing[4]);
    assert.deepEqual(holeRing[0], holeRing[4]);
});

test('validate: closeRings=false leaves rings open without a duplicated first point', () => {
    const feature = featureOf({
        type: 3,
        geometry: polygonGeometry([[[1, 1], [2, 1], [2, 2]]])
    });

    const ring = feature.toGeoJSON(0, 0, 0, {validate: true, closeRings: false})
        .geometry.coordinates[0];
    assert.equal(ring.length, 3);
    assert.notDeepEqual(ring[0], ring[ring.length - 1]);
});

test('validate: normalizeWinding forces outer CCW and holes CW regardless of input', () => {
    // A mis-wound outer ring is the same square traversed in reverse, so it
    // keeps the shape but flips the winding.
    const correct = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const miswound = correct.slice().reverse();

    /** @param {number[][]} ring */
    function polygonFeature(ring) {
        return featureOf({type: 3, geometry: polygonGeometry([ring])});
    }

    // Validation alone does not reject the winding — normalization is opt-in.
    assert.doesNotThrow(() => polygonFeature(miswound).toGeoJSON(0, 0, 0, {validate: true}));

    const normalized = polygonFeature(miswound)
        .toGeoJSON(0, 0, 0, {validate: true, normalizeWinding: true})
        .geometry.coordinates[0];
    const reference = polygonFeature(correct)
        .toGeoJSON(0, 0, 0, {validate: true, normalizeWinding: true})
        .geometry.coordinates[0];

    // Reversing the mis-wound ring restores the correct ring exactly.
    assert.deepEqual(normalized, reference);
    assert.deepEqual(normalized[0], normalized[normalized.length - 1]);

    // normalizeWinding leaves an already-correct ring untouched (same order).
    const untouched = polygonFeature(correct)
        .toGeoJSON(0, 0, 0, {validate: true, normalizeWinding: true})
        .geometry.coordinates[0];
    assert.deepEqual(untouched, reference);

    // Without normalization the mis-wound input is emitted as-is.
    const raw = polygonFeature(miswound)
        .toGeoJSON(0, 0, 0, {validate: true})
        .geometry.coordinates[0];
    assert.notDeepEqual(raw, reference);
});

test('validate: LineTo without a preceding MoveTo is rejected', () => {
    const feature = featureOf({
        type: 2,
        geometry: [cmd(LINE_TO, 1), zz(1), zz(1)]
    });
    assertVectorTileError(
        () => feature.toGeoJSON(0, 0, 0, {validate: true}),
        /not preceded by a MoveTo/);
});

test('validate: a polygon ring with fewer than three distinct points is rejected', () => {
    // Two distinct vertices only: (1,1)->(2,2), then ClosePath.
    const feature = featureOf({
        type: 3,
        geometry: polygonGeometry([[[1, 1], [2, 2]]])
    });
    assertVectorTileError(
        () => feature.toGeoJSON(0, 0, 0, {validate: true}),
        /at least three distinct points/);
});
