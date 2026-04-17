/**
 * Attribute / event-attribute translation for the OTel exporter.
 *
 * Wave-16 M2 extraction. Owns:
 *
 *   - the OBS-011 legacy-name → semconv rename table for cache metrics,
 *   - the Wave-12 P2-12 JSON-stringify fallback for object attributes,
 *   - the OBS-004 "dropped attribute" counters + caller-notification hook.
 *
 * @module
 * @internal
 */

import type { Span as OTelSpan } from '@opentelemetry/api';

/**
 * OBS-011: Mapping from harness-one cache-monitor metric names to
 * OpenTelemetry semantic-convention-friendly names. Applied in
 * `setSpanAttributes` when the span attribute name matches one of the
 * legacy keys. Primitive-valued only.
 */
export const CACHE_ATTR_RENAME: Record<string, string> = {
  hitRate: 'cache.hit_ratio',
  missRate: 'cache.miss_ratio',
  avgLatency: 'cache.latency_ms',
};

/** Shape of the payload delivered to the caller-supplied drop observer. */
export interface DroppedAttributeInfo {
  readonly key: string;
  readonly type: string;
  readonly where: 'attribute' | 'event';
}

export interface AttributeSinkConfig {
  readonly stringifyComplexAttributes: boolean;
  readonly onDroppedAttribute?: (info: DroppedAttributeInfo) => void;
}

export interface AttributeSink {
  /** Apply a bag of mixed-type attributes to `otelSpan`, dropping non-primitives. */
  applyAttributes(otelSpan: OTelSpan, attrs: Record<string, unknown>): void;
  /**
   * Translate a bag of event-attributes into the OTel-safe subset, counting
   * drops. Returns the translated bag so the caller can pass it to
   * `otelSpan.addEvent`.
   */
  filterEventAttributes(attrs: Record<string, unknown> | undefined): Record<string, string | number | boolean>;
  /** Total attribute drops observed on span attributes. */
  getDroppedAttributes(): number;
  /** Total attribute drops observed on span-event attributes. */
  getDroppedEventAttributes(): number;
}

export function createAttributeSink(config: AttributeSinkConfig): AttributeSink {
  const { stringifyComplexAttributes, onDroppedAttribute } = config;
  let droppedAttributes = 0;
  let droppedEventAttributes = 0;

  function reportDroppedAttribute(info: DroppedAttributeInfo): void {
    if (onDroppedAttribute) {
      onDroppedAttribute(info);
      return;
    }
    // Fallback retained from the pre-split implementation so existing tests
    // and deployments still see the signal.
    if (typeof console !== 'undefined') {
      console.debug(`Dropping non-primitive attribute '${info.key}' of type '${info.type}'`);
    }
  }

  function applyAttributes(otelSpan: OTelSpan, attrs: Record<string, unknown>): void {
    for (const [rawKey, value] of Object.entries(attrs)) {
      const key = CACHE_ATTR_RENAME[rawKey] ?? rawKey;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        otelSpan.setAttribute(key, value);
      } else if (value !== undefined && value !== null) {
        // Wave-12 P2-12: optional JSON-stringify fallback. Only attempted for
        // object-shaped values — functions/symbols still cannot be represented
        // as string attributes without silently producing "[object Object]"
        // or similar, so we continue to drop them. A failing JSON.stringify
        // (circular refs, throwing getters) falls through to the drop path.
        if (stringifyComplexAttributes && typeof value === 'object') {
          try {
            otelSpan.setAttribute(key, JSON.stringify(value));
            continue;
          } catch {
            // fall through to drop path below
          }
        }
        droppedAttributes++;
        reportDroppedAttribute({ key, type: typeof value, where: 'attribute' });
      }
    }
  }

  function filterEventAttributes(
    attrs: Record<string, unknown> | undefined,
  ): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    if (!attrs) return out;
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[k] = v;
      } else {
        droppedEventAttributes++;
        // Event-attribute drops share the same hook but no console fallback —
        // matches legacy behaviour.
        onDroppedAttribute?.({ key: k, type: typeof v, where: 'event' });
      }
    }
    return out;
  }

  return {
    applyAttributes,
    filterEventAttributes,
    getDroppedAttributes: () => droppedAttributes,
    getDroppedEventAttributes: () => droppedEventAttributes,
  };
}
