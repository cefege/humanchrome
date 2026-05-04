export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonArray = JsonValue[];

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** ISO 8601 date-time string. */
export type ISODateTimeString = string;

/** Unix epoch in milliseconds. */
export type UnixMillis = number;
