/** Unit tests for the library folder tree helpers. */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTree, canMove, descendantIds, flatPaths, folderPath, papersInFolder, suggestName, visibleRows,
} from "../src/utils/folderTree.ts";

const F = (id, name, parent_id = null, paper_count = 0) => ({ id, name, parent_id, paper_count });
const folders = [F(1, "Thesis"), F(2, "chapter 2", 1), F(3, "Methods", 2), F(4, "Archive"), F(5, "Ideas", 1)];

test("the tree is sorted by name, ignoring case, with depths", () => {
  const tree = buildTree(folders);
  assert.deepEqual(tree.map((n) => n.name), ["Archive", "Thesis"]);
  const thesis = tree[1];
  assert.deepEqual(thesis.children.map((n) => n.name), ["chapter 2", "Ideas"]);
  assert.deepEqual([thesis.depth, thesis.children[0].depth, thesis.children[0].children[0].depth], [0, 1, 2]);
});

test("numbers sort naturally", () => {
  const tree = buildTree([F(1, "Ch 10"), F(2, "Ch 2"), F(3, "Ch 1")]);
  assert.deepEqual(tree.map((n) => n.name), ["Ch 1", "Ch 2", "Ch 10"]);
});

test("descendants include every depth but not the folder", () => {
  assert.deepEqual(descendantIds(folders, 1).sort(), [2, 3, 5]);
  assert.deepEqual(descendantIds(folders, 3), []);
});

test("paths read from the top", () => {
  assert.equal(folderPath(folders, 3), "Thesis / chapter 2 / Methods");
  assert.equal(folderPath(folders, 4), "Archive");
  assert.equal(folderPath(folders, 99), "");
});

test("flat paths follow the tree order", () => {
  assert.deepEqual(flatPaths(folders).map((r) => r.path), [
    "Archive", "Thesis", "Thesis / chapter 2", "Thesis / chapter 2 / Methods", "Thesis / Ideas",
  ]);
});

test("collapsed folders hide their subtree", () => {
  const tree = buildTree(folders);
  assert.equal(visibleRows(tree, new Set()).length, 5);
  assert.deepEqual(visibleRows(tree, new Set([1])).map((n) => n.name), ["Archive", "Thesis"]);
});

test("a folder's papers, with and without subfolders", () => {
  const memberships = { 10: [3], 11: [1], 12: [4], 13: [2, 4] };
  assert.deepEqual([...papersInFolder(folders, memberships, 1, false)].sort(), [11]);
  assert.deepEqual([...papersInFolder(folders, memberships, 1, true)].sort(), [10, 11, 13]);
  assert.deepEqual([...papersInFolder(folders, memberships, 4, true)].sort(), [12, 13]);
});

test("move rules: not into itself, its subtree, its own parent, or too deep", () => {
  assert.equal(canMove(folders, 1, 1, 6), false);
  assert.equal(canMove(folders, 1, 3, 6), false);       // into its own descendant
  assert.equal(canMove(folders, 2, 1, 6), false);       // already there
  assert.equal(canMove(folders, 3, null, 6), true);     // to the top level
  assert.equal(canMove(folders, 4, 5, 6), true);
});

test("the depth limit counts the whole subtree being moved", () => {
  assert.equal(canMove(folders, 1, 4, 3), false);       // 1 (Archive) + 1 + 2 = 4 levels > 3
  assert.equal(canMove(folders, 1, 4, 4), true);
});

test("suggested names avoid siblings but not other parents", () => {
  assert.equal(suggestName([], null), "New folder");
  const taken = [F(1, "New folder"), F(2, "New folder 2"), F(3, "New folder", 1)];
  assert.equal(suggestName(taken, null), "New folder 3");
  assert.equal(suggestName(taken, 1), "New folder 2");
  assert.equal(suggestName([F(1, "new FOLDER")], null), "New folder 2");
});
