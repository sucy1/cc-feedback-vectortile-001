
import Point from '@mapbox/point-geometry';

/** @import {PbfReader} from 'pbf' */
/** @import {Feature} from 'geojson' */

/**
 * @typedef {object} ToGeoJSONOptions
 * @property {boolean} [validate] strictly validate the geometry command sequence and
 * throw a {@link VectorTileError} (carrying `featureId`, `layer` and `reason`) instead of
 * returning a partial result
 * @property {boolean} [closeRings] automatically close polygon rings without duplicating
 * the first point (default: `true`)
 * @property {boolean} [normalizeWinding] rewind polygon rings so that outer rings wind
 * counterclockwise and holes clockwise in tile coordinates
 */

/** Error thrown for invalid feature geometry when `validate` is enabled. */
export class VectorTileError extends Error {
    /**
     * @param {string} reason
     * @param {number | undefined} featureId
     * @param {string | undefined} layer
     */
    constructor(reason, featureId, layer) {
        super(`invalid vector tile geometry${layer ? ` in layer "${layer}"` : ''}${featureId != null ? ` for feature ${featureId}` : ''}: ${reason}`);
        this.name = 'VectorTileError';
        this.reason = reason;
        this.featureId = featureId;
        this.layer = layer;
    }
}

export class VectorTileFeature {
    /**
     * @param {PbfReader} pbf
     * @param {number} end
     * @param {number} extent
     * @param {string[]} keys
     * @param {(number | string | boolean)[]} values
     */
    constructor(pbf, end, extent, keys, values) {
        // Public

        /** @type {Record<string, number | string | boolean>} */
        this.properties = Object.create(null);

        this.extent = extent;
        /** @type {0 | 1 | 2 | 3} */
        this.type = 0;

        /** @type {number | undefined} */
        this.id = undefined;

        /** @private */
        this._pbf = pbf;
        /** @private */
        this._geometry = -1;
        /** @private */
        this._keys = keys;
        /** @private */
        this._values = values;
        /** @type {string | undefined} layer name, set internally by VectorTileLayer */
        this._layer = undefined;

        while (pbf.pos < end) {
            const tag = pbf.readVarint();
            if (tag === 8) this.id = pbf.readVarint();
            else if (tag === 18) {
                const tagsEnd = pbf.readVarint() + pbf.pos;
                while (pbf.pos < tagsEnd) {
                    const key = keys[pbf.readVarint()];
                    const value = values[pbf.readVarint()];
                    this.properties[key] = value;
                }
            } else if (tag === 24) this.type = /** @type {0 | 1 | 2 | 3} */ (pbf.readVarint());
            else if (tag === 34) {
                this._geometry = pbf.pos;
                pbf.skip(tag);
            } else pbf.skip(tag);
        }
    }

    loadGeometry() {
        return this._readGeometry(false).lines;
    }

    bbox() {
        return this._readGeometry(false).bbox;
    }

    /**
     * Shared command-sequence parser for `loadGeometry`, `bbox` and `toGeoJSON`.
     * With `validate` enabled, malformed command streams throw a `VectorTileError`
     * instead of being silently skipped or misinterpreted.
     *
     * @private
     * @param {boolean} validate
     * @returns {{lines: Point[][], bbox: number[], closed: boolean[]}}
     */
    _readGeometry(validate) {
        if (this._geometry < 0) {
            if (validate) throw this._error('feature has no geometry');
            throw new Error('feature has no geometry');
        }
        const pbf = this._pbf;
        pbf.pos = this._geometry;

        const end = pbf.readVarint() + pbf.pos;

        /** @type Point[][] */
        const lines = [];
        /** @type {boolean[]} whether each line was terminated by a ClosePath command */
        const closed = [];

        /** @type Point[] | undefined */
        let line;
        let lineClosed = false;

        let cmd = 1;
        let length = 0;
        let x = 0;
        let y = 0;
        let x1 = Infinity,
            x2 = -Infinity,
            y1 = Infinity,
            y2 = -Infinity;
        let sawCommand = false;

        /** @param {string} reason */
        const fail = (reason) => { throw this._error(reason); };

        /**
         * @param {number} nx
         * @param {number} ny
         */
        const checkRange = (nx, ny) => {
            if (nx < 0 || nx > this.extent || ny < 0 || ny > this.extent) {
                fail(`coordinate (${nx}, ${ny}) is outside the tile extent [0, ${this.extent}]`);
            }
        };

        const finishLine = () => {
            if (line) {
                lines.push(line);
                closed.push(lineClosed);
                line = undefined;
                lineClosed = false;
            }
        };

        while (pbf.pos < end) {
            if (length <= 0) {
                const cmdLen = pbf.readVarint();
                cmd = cmdLen & 0x7;
                length = cmdLen >> 3;
                if (length === 0) {
                    if (validate) fail('geometry command with a length of 0');
                    continue;
                }
                sawCommand = true;
                if (validate && cmd !== 1 && cmd !== 2 && cmd !== 7) {
                    fail(`unknown command ${cmd}`);
                }
            }

            length--;

            if (cmd === 1) { // moveTo
                x += pbf.readSVarint();
                y += pbf.readSVarint();
                if (validate) checkRange(x, y);
                if (x < x1) x1 = x;
                if (x > x2) x2 = x;
                if (y < y1) y1 = y;
                if (y > y2) y2 = y;
                finishLine();
                line = [new Point(x, y)];

            } else if (cmd === 2) { // lineTo
                if (!line) {
                    if (validate) fail('LineTo command is not preceded by a MoveTo command');
                    line = [];
                }
                x += pbf.readSVarint();
                y += pbf.readSVarint();
                if (validate) checkRange(x, y);
                if (x < x1) x1 = x;
                if (x > x2) x2 = x;
                if (y < y1) y1 = y;
                if (y > y2) y2 = y;
                line.push(new Point(x, y));

            } else if (cmd === 7) { // closePath
                if (!line) {
                    if (validate) fail('ClosePath command is not preceded by a MoveTo command');
                    continue;
                }
                lineClosed = true;
                line.push(line[0].clone()); // closePolygon

            } else {
                throw new Error(`unknown command ${cmd}`);
            }
        }

        finishLine();

        if (validate) {
            if (!sawCommand) fail('empty geometry command sequence');
            this._validateLines(lines, closed);
        }

        return {
            lines,
            closed,
            bbox: [x1, y1, x2, y2]
        };
    }

    /**
     * Performs the type-specific structural checks that only make sense once the
     * whole command stream has been read.
     *
     * @private
     * @param {Point[][]} lines
     * @param {boolean[]} closed
     */
    _validateLines(lines, closed) {
        /** @param {string} reason */
        const fail = (reason) => { throw this._error(reason); };

        if (this.type === 1) { // Point
            for (const line of lines) {
                if (line.length !== 1) fail('Point geometry may only contain MoveTo commands with one point each');
            }

        } else if (this.type === 2) { // LineString
            if (lines.length === 0) fail('LineString geometry contains no paths');
            for (const line of lines) {
                if (line.length < 2) fail('LineString path must contain at least two points');
            }

        } else if (this.type === 3) { // Polygon
            if (lines.length === 0) fail('Polygon geometry contains no rings');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!closed[i]) fail('polygon ring is not terminated by a ClosePath command');
                // The closing point duplicates the first one, so a valid ring has
                // at least four coordinates / three distinct vertices.
                if (line.length < 4) fail('polygon ring must contain at least three distinct points');
                if (signedArea(line) === 0) fail('polygon ring has zero area');
            }

        } else {
            fail(`unknown feature type ${this.type}`);
        }
    }

    /**
     * Builds a {@link VectorTileError} annotated with this feature's id and layer.
     *
     * @private
     * @param {string} reason
     * @returns {VectorTileError}
     */
    _error(reason) {
        return new VectorTileError(reason, this.id, this._layer);
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {ToGeoJSONOptions} [options]
     * @return {Feature}
     */
    toGeoJSON(x, y, z, options) {
        const validate = !!options && !!options.validate;
        const size = this.extent * Math.pow(2, z),
            x0 = this.extent * x,
            y0 = this.extent * y,
            parsed = this._readGeometry(validate);

        /** @param {Point} p */
        function projectPoint(p) {
            return [
                (p.x + x0) * 360 / size - 180,
                360 / Math.PI * Math.atan(Math.exp((1 - (p.y + y0) * 2 / size) * Math.PI)) - 90
            ];
        }

        /** @param {Point[]} line */
        function projectLine(line) {
            return line.map(projectPoint);
        }

        /** @type {Feature["geometry"]} */
        let geometry;

        if (this.type === 1) {
            const points = [];
            for (const line of parsed.lines) {
                points.push(line[0]);
            }
            const coordinates = projectLine(points);
            geometry = points.length === 1 ?
                {type: 'Point', coordinates: coordinates[0]} :
                {type: 'MultiPoint', coordinates};

        } else if (this.type === 2) {

            const coordinates = parsed.lines.map(projectLine);
            geometry = coordinates.length === 1 ?
                {type: 'LineString', coordinates: coordinates[0]} :
                {type: 'MultiLineString', coordinates};

        } else if (this.type === 3) {
            const closeRings = !options || options.closeRings !== false;
            const normalizeWinding = !!options && !!options.normalizeWinding;

            // Strip the synthetic closing point so rings can be re-closed at most
            // once, never duplicating the first vertex.
            const rings = parsed.lines.map((ring) => {
                const result = ring.slice();
                if (result.length > 1 && result[result.length - 1].equals(result[0])) {
                    result.pop();
                }
                return result;
            });

            const polygons = classifyRings(rings);

            if (validate) {
                // A Polygon must have exactly one outer ring. In this library's
                // signed-area convention outer rings are positive and holes
                // negative, so a second positive ring means two outer rings
                // were merged into one Polygon.
                for (const polygon of polygons) {
                    for (let i = 1; i < polygon.length; i++) {
                        if (signedArea(polygon[i]) > 0) {
                            throw this._error('two outer rings are merged into a single Polygon');
                        }
                    }
                }
            }

            const coordinates = [];
            for (const polygon of polygons) {
                coordinates.push(polygon.map((ring, ringIndex) => {
                    const isOuter = ringIndex === 0;
                    let result = ring;
                    if (normalizeWinding) {
                        // Outer rings wind counterclockwise (positive signed
                        // area in tile coordinates) and holes clockwise.
                        const area = signedArea(ring);
                        const wantsPositive = isOuter;
                        if ((area > 0) !== wantsPositive) result = ring.slice().reverse();
                    }
                    if (closeRings) result = result.concat([result[0]]);
                    return projectLine(result);
                }));
            }
            geometry = coordinates.length === 1 ?
                {type: 'Polygon', coordinates: coordinates[0]} :
                {type: 'MultiPolygon', coordinates};
        } else {

            if (validate) throw this._error(`unknown feature type ${this.type}`);
            throw new Error('unknown feature type');
        }

        /** @type {Feature} */
        const result = {
            type: 'Feature',
            geometry,
            properties: this.properties
        };

        if (this.id != null) {
            result.id = this.id;
        }

        return result;
    }
}

/** @type {['Unknown', 'Point', 'LineString', 'Polygon']} */
VectorTileFeature.types = ['Unknown', 'Point', 'LineString', 'Polygon'];

/** classifies an array of rings into polygons with outer rings and holes
 * @param {Point[][]} rings
 */
export function classifyRings(rings) {
    const len = rings.length;

    if (len <= 1) return [rings];

    const polygons = [];
    let polygon, ccw;

    for (let i = 0; i < len; i++) {
        const area = signedArea(rings[i]);
        if (area === 0) continue;

        if (ccw === undefined) ccw = area < 0;

        if (ccw === area < 0) {
            if (polygon) polygons.push(polygon);
            polygon = [rings[i]];

        } else if (polygon) {
            polygon.push(rings[i]);
        }
    }
    if (polygon) polygons.push(polygon);

    return polygons;
}

/** @param {Point[]} ring */
function signedArea(ring) {
    let sum = 0;
    for (let i = 0, len = ring.length, j = len - 1, p1, p2; i < len; j = i++) {
        p1 = ring[i];
        p2 = ring[j];
        sum += (p2.x - p1.x) * (p1.y + p2.y);
    }
    return sum;
}

export class VectorTileLayer {
    /**
     * @param {PbfReader} pbf
     * @param {number} [end]
     */
    constructor(pbf, end) {
        // Public
        this.version = 1;
        this.name = '';
        this.extent = 4096;
        this.length = 0;

        /** @private */
        this._pbf = pbf;

        /** @private
         * @type {string[]} */
        this._keys = [];

        /** @private
         * @type {(number | string | boolean)[]} */
        this._values = [];

        /** @private
         * @type {number[]} */
        this._features = [];

        if (end === undefined) end = pbf.length;
        while (pbf.pos < end) {
            const tag = pbf.readVarint();
            if (tag === 10) this.name = pbf.readString();
            else if (tag === 18) {
                this._features.push(pbf.pos);
                pbf.skip(tag);
            } else if (tag === 26) this._keys.push(pbf.readString());
            else if (tag === 34) this._values.push(readValueMessage(pbf));
            else if (tag === 40) this.extent = pbf.readVarint();
            else if (tag === 120) this.version = pbf.readVarint();
            else pbf.skip(tag);
        }

        this.length = this._features.length;
    }

    /** return feature `i` from this layer as a `VectorTileFeature`
     * @param {number} i
     */
    feature(i) {
        if (i < 0 || i >= this._features.length) throw new Error('feature index out of bounds');

        this._pbf.pos = this._features[i];

        const end = this._pbf.readVarint() + this._pbf.pos;
        const feature = new VectorTileFeature(this._pbf, end, this.extent, this._keys, this._values);
        feature._layer = this.name;
        return feature;
    }
}

/**
 * @param {PbfReader} pbf
 */
function readValueMessage(pbf) {
    let value = null;
    const end = pbf.readVarint() + pbf.pos;

    while (pbf.pos < end) {
        const tag = pbf.readVarint();
        value =
            tag === 10 ? pbf.readString() :
            tag === 21 ? pbf.readFloat() :
            tag === 25 ? pbf.readDouble() :
            tag === 32 ? pbf.readVarint(true) :
            tag === 40 ? pbf.readVarint() :
            tag === 48 ? pbf.readSVarint() :
            tag === 56 ? pbf.readBoolean() :
            (pbf.skip(tag), null);
    }
    if (value == null) {
        throw new Error('unknown feature value');
    }

    return value;
}

export class VectorTile {
    /**
     * @param {PbfReader} pbf
     * @param {number} [end]
     */
    constructor(pbf, end = pbf.length) {
        /** @type {Record<string, VectorTileLayer>} */
        const layers = Object.create(null);
        while (pbf.pos < end) {
            const tag = pbf.readVarint();
            if (tag === 26) {
                const layer = new VectorTileLayer(pbf, pbf.readVarint() + pbf.pos);
                if (layer.length) layers[layer.name] = layer;
            } else pbf.skip(tag);
        }
        this.layers = layers;
    }
}
