import { ProviderRequestError } from "../errors.ts";
import { isRecord, object, text, type Wire } from "./json.ts";
import { invalid, requestArray } from "./validation.ts";
export interface ToolMapping {
  readonly name: string;
  readonly wireName: string;
  readonly namespace?: string;
  readonly custom: boolean;
  readonly dispatcher: boolean;
}
interface SchemaBudget {
  nodes: number;
  characters: number;
}
function toolSchema(
  value: unknown,
  budget: SchemaBudget,
  root = value,
  depth = 0,
): Wire {
  if (--budget.nodes < 0 || budget.characters < 0)
    invalid("Expanded tool schemas exceed the size limit");
  if (depth > 32) invalid("Tool schema is recursive or too deeply nested");
  if (!isRecord(value)) invalid("Tool schemas must be JSON objects");
  const current = object(value);
  if (typeof current.$ref === "string") {
    if (!current.$ref.startsWith("#/"))
      invalid("External tool schema references are unsupported");
    let target: unknown = root;
    for (const key of current.$ref.slice(2).split("/"))
      target = object(target)[key.replaceAll("~1", "/").replaceAll("~0", "~")];
    if (!target) invalid("Unresolved tool schema reference");
    const { $ref: _ref, ...rest } = current;
    return toolSchema({ ...object(target), ...rest }, budget, root, depth + 1);
  }
  return Object.fromEntries(
    Object.entries(current)
      .filter(([key]) => key !== "$defs" && key !== "definitions")
      .map(([key, child]) => {
        if (key === "properties")
          return [
            key,
            Object.fromEntries(
              Object.entries(object(child)).map(([name, value]) => [
                name,
                toolSchema(value, budget, root, depth + 1),
              ]),
            ),
          ];
        if (
          ["items", "additionalProperties", "not"].includes(key) &&
          typeof child === "object"
        )
          return [key, toolSchema(child, budget, root, depth + 1)];
        if (["oneOf", "anyOf", "allOf"].includes(key) && Array.isArray(child))
          return [
            key,
            child.map((entry) => toolSchema(entry, budget, root, depth + 1)),
          ];
        budget.characters -= key.length + (JSON.stringify(child)?.length ?? 0);
        if (budget.characters < 0)
          invalid("Expanded tool schemas exceed the size limit");
        return [key, child];
      }),
  );
}

/** Flatten native tools once. Large namespaces use one explicit dispatcher each. */
export function translateTools(
  value: unknown,
  anthropic: boolean,
): { definitions: Wire[]; mappings: ToolMapping[] } {
  const declared = value === undefined ? [] : requestArray(value, "tools");
  const count = declared.reduce(
    (total, tool) =>
      total +
      (tool.type === "namespace"
        ? requestArray(tool.tools, "namespace tools").length
        : 1),
    0,
  );
  const fold = count > 200;
  const mappings: ToolMapping[] = [];
  const definitions: Wire[] = [];
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const budget: SchemaBudget = { nodes: 100000, characters: 8 * 1024 * 1024 };
  function add(
    tool: Wire,
    namespace?: string,
    dispatcherName?: string,
  ): { name: string; definition: Wire; parameters: Wire } {
    const type =
      anthropic && tool.type === undefined ? "function" : text(tool.type);
    if (type !== "function" && type !== "custom")
      invalid(`Unsupported xAI tool: ${type}`);
    const name = text(tool.name);
    if (!name) invalid("Tool name is required");
    const identity = JSON.stringify([namespace ?? null, name]);
    if (names.has(identity)) invalid("Duplicate tool name");
    names.add(identity);
    const wireName = dispatcherName ?? `cody_tool_${mappings.length}`;
    const custom = type === "custom";
    if (tool.strict !== undefined && typeof tool.strict !== "boolean")
      invalid("Tool strict must be a boolean");
    if (
      custom &&
      tool.format !== undefined &&
      object(tool.format).type !== "text"
    )
      invalid("xAI cannot enforce custom tool grammars");
    if (dispatcherName && tool.strict === true)
      invalid("xAI cannot enforce strict tools in a folded namespace");
    const parameters: Wire = custom
      ? {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        }
      : toolSchema(
          tool.parameters ??
            tool.input_schema ?? { type: "object", properties: {} },
          budget,
        );
    if (parameters.type !== undefined && parameters.type !== "object")
      invalid("Function tool parameters must describe an object");
    parameters.type = "object";
    for (const composition of ["oneOf", "anyOf", "allOf"]) {
      const branches = parameters[composition];
      if (Array.isArray(branches)) {
        parameters[composition] = branches.map((branch) => ({
          type: "object",
          ...object(branch),
        }));
      }
    }
    mappings.push({
      name,
      wireName,
      ...(namespace ? { namespace } : {}),
      custom,
      dispatcher: dispatcherName !== undefined,
    });
    return {
      name,
      parameters,
      definition: {
        type: "function",
        name: wireName,
        description: text(tool.description),
        parameters,
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    };
  }
  for (const tool of declared) {
    if (tool.type !== "namespace") {
      definitions.push(add(tool).definition);
      continue;
    }
    const namespace = text(tool.name);
    if (!namespace || namespaces.has(namespace))
      invalid("Namespace names must be nonempty and unique");
    namespaces.add(namespace);
    const children = requestArray(tool.tools, "namespace tools");
    if (!children.length) invalid("Namespaces must contain tools");
    if (!fold) {
      for (const child of children)
        definitions.push(add(child, namespace).definition);
      continue;
    }
    const wireName = `cody_namespace_${definitions.length}`;
    const branches = children.map((child) => {
      const translated = add(child, namespace, wireName);
      return {
        type: "object",
        properties: {
          name: { type: "string", const: translated.name },
          arguments: {
            ...translated.parameters,
            description: translated.definition.description,
          },
        },
        required: ["name", "arguments"],
        additionalProperties: false,
      };
    });
    definitions.push({
      type: "function",
      name: wireName,
      description: text(tool.description),
      parameters: { type: "object", oneOf: branches },
    });
  }
  if (definitions.length > 200)
    invalid("xAI supports at most 200 tools after namespace folding");
  return { definitions, mappings };
}
export function findTool(
  mappings: readonly ToolMapping[],
  name: string,
  namespace?: string,
): ToolMapping {
  const candidates = mappings.filter(
    (mapping) =>
      mapping.name === name && (!namespace || mapping.namespace === namespace),
  );
  const [match] = candidates;
  if (!match || candidates.length !== 1)
    invalid(`Unknown or ambiguous tool: ${name}`);
  return match;
}
export function restoreTool(item: Wire, tools: readonly ToolMapping[]): Wire {
  let mapping = tools.find((tool) => tool.wireName === item.name);
  if (!mapping)
    throw new ProviderRequestError("xAI returned an undeclared tool", 502);
  let args = text(item.arguments);
  if (mapping.dispatcher) {
    let decoded: Wire;
    try {
      decoded = object(JSON.parse(args));
    } catch {
      throw new ProviderRequestError("Invalid xAI namespace call", 502);
    }
    mapping = tools.find(
      (tool) => tool.wireName === item.name && tool.name === decoded.name,
    );
    if (!mapping)
      throw new ProviderRequestError("Unknown xAI namespace child", 502);
    args = JSON.stringify(decoded.arguments ?? {});
  }
  if (mapping.custom) {
    let input: unknown;
    try {
      input = object(JSON.parse(args)).input;
    } catch {
      throw new ProviderRequestError("Invalid xAI custom tool input", 502);
    }
    if (typeof input !== "string")
      throw new ProviderRequestError("Invalid xAI custom tool input", 502);
    return {
      ...item,
      type: "custom_tool_call",
      name: mapping.name,
      ...(mapping.namespace ? { namespace: mapping.namespace } : {}),
      input,
      arguments: undefined,
    };
  }
  return {
    ...item,
    name: mapping.name,
    ...(mapping.namespace ? { namespace: mapping.namespace } : {}),
    arguments: args,
  };
}
