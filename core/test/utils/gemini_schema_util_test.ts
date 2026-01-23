/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { toGeminiSchema } from "@google/adk/utils/gemini_schema_util";
import { Type } from "@google/genai";

describe("toGeminiSchema", () => {
	it("converts a simple object schema with explicit type", () => {
		const input = {
			type: "object",
			properties: {
				name: { type: "string" },
				age: { type: "number" },
			},
			required: ["name"],
		};

		const schema = toGeminiSchema(input as any);

		expect(schema).toEqual({
			type: Type.OBJECT,
			properties: {
				name: { type: Type.STRING },
				age: { type: Type.NUMBER },
			},
			required: ["name"],
		});
	});

	it("infers OBJECT type from properties when type is missing", () => {
		const input = {
			properties: {
				name: { type: "string" },
			},
		};

		const schema = toGeminiSchema(input as any);

		expect(schema).toEqual({
			type: Type.OBJECT,
			properties: {
				name: { type: Type.STRING },
			},
		});
	});

	it("infers ARRAY type from items when type is missing", () => {
		const input = {
			items: { type: "string" },
		};

		const schema = toGeminiSchema(input as any);

		expect(schema).toEqual({
			type: Type.ARRAY,
			items: { type: Type.STRING },
		});
	});

	it("handles optional types (anyOf with null) by picking the non-null type", () => {
		const input = {
			anyOf: [{ type: "string" }, { type: "null" }],
		};

		const schema = toGeminiSchema(input as any);

		// Should resolve to STRING
		expect(schema).toEqual({
			type: Type.STRING,
		});
	});

	it("handles optional types (anyOf with null) reverse order", () => {
		const input = {
			anyOf: [{ type: "null" }, { type: "string" }],
		};

		const schema = toGeminiSchema(input as any);

		expect(schema).toEqual({
			type: Type.STRING,
		});
	});

	it("handles nested complex schemas with missing types", () => {
		const input = {
			// Missing top-level type, inferred as OBJECT
			properties: {
				tags: {
					// Missing array type, inferred as ARRAY
					items: { type: "string" },
				},
				metadata: {
					// Optional object via anyOf
					anyOf: [
						{
							properties: { created: { type: "string" } },
						},
						{ type: "null" },
					],
				},
			},
		};

		const schema = toGeminiSchema(input as any);

		expect(schema).toEqual({
			type: Type.OBJECT,
			properties: {
				tags: {
					type: Type.ARRAY,
					items: { type: Type.STRING },
				},
				metadata: {
					type: Type.OBJECT,
					properties: {
						created: { type: Type.STRING },
					},
				},
			},
		});
	});

	it("handles $ref by defaulting to OBJECT", () => {
		const input = {
			$ref: "#/definitions/MyType",
		};

		const schema = toGeminiSchema(input as any);

		expect(schema).toEqual({
			type: Type.OBJECT,
			properties: {},
		});
	});
});
