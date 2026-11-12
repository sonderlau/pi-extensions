import type { Kind } from "./kinds.ts";
import type { Table } from "./parse.ts";

export const SAMPLES: { kind: Kind; title: string; table: Table }[] = [
	{
		kind: "bar",
		title: "fruit counts",
		table: {
			headers: ["fruit", "count"],
			rows: [
				["apple", "42"],
				["pear", "18"],
				["grape", "31"],
				["mango", "9"],
			],
		},
	},
	{
		kind: "grouped",
		title: "quarterly revenue",
		table: {
			headers: ["q", "alpha", "beta"],
			rows: [
				["Q1", "12", "8"],
				["Q2", "18", "11"],
				["Q3", "15", "14"],
				["Q4", "22", "17"],
			],
		},
	},
	{
		kind: "stacked",
		title: "stack mix",
		table: {
			headers: ["team", "dev", "ops", "qa"],
			rows: [
				["A", "40", "20", "10"],
				["B", "25", "25", "20"],
				["C", "10", "30", "15"],
			],
		},
	},
	{
		kind: "line",
		title: "monthly users",
		table: {
			headers: ["month", "users"],
			rows: [
				["Jan", "120"],
				["Feb", "150"],
				["Mar", "140"],
				["Apr", "180"],
				["May", "210"],
				["Jun", "190"],
			],
		},
	},
	{
		kind: "slope",
		title: "before after",
		table: {
			headers: ["item", "before", "after"],
			rows: [
				["latency", "240", "180"],
				["errors", "12", "4"],
				["score", "61", "78"],
			],
		},
	},
	{
		kind: "share",
		title: "market share",
		table: {
			headers: ["brand", "share"],
			rows: [
				["acme", "45%"],
				["globex", "30%"],
				["initech", "15%"],
				["other", "10%"],
			],
		},
	},
	{
		kind: "heatmap",
		title: "matrix",
		table: {
			headers: ["row", "a", "b", "c", "d"],
			rows: [
				["n", "1", "3", "8", "2"],
				["e", "4", "9", "6", "1"],
				["s", "2", "5", "7", "4"],
				["w", "8", "2", "3", "9"],
			],
		},
	},
	{
		kind: "histogram",
		title: "ages",
		table: {
			headers: ["age"],
			rows: ["12", "15", "16", "18", "19", "21", "22", "22", "24", "29", "31", "33", "40", "44", "51"].map((n) => [n]),
		},
	},
	{
		kind: "scatter",
		title: "height weight",
		table: {
			headers: ["h", "w"],
			rows: [
				["160", "52"],
				["165", "58"],
				["170", "66"],
				["172", "70"],
				["178", "74"],
				["182", "81"],
				["185", "88"],
			],
		},
	},
	{
		kind: "stat",
		title: "kpis",
		table: {
			headers: ["p50", "p95", "err"],
			rows: [["42", "118", "0.3"]],
		},
	},
	{
		kind: "progress",
		title: "jobs",
		table: {
			headers: ["job", "done", "total"],
			rows: [
				["index", "80", "100"],
				["sync", "12", "40"],
			],
		},
	},
	{
		kind: "diverging",
		title: "pnl",
		table: {
			headers: ["region", "pnl"],
			rows: [
				["north", "12"],
				["east", "-4"],
				["south", "7"],
				["west", "-9"],
			],
		},
	},
];
