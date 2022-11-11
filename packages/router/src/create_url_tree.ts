/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ɵRuntimeError as RuntimeError} from '@angular/core';

import {RuntimeErrorCode} from './errors';
import {ActivatedRoute, ActivatedRouteSnapshot} from './router_state';
import {Params, PRIMARY_OUTLET} from './shared';
import {createRoot, squashSegmentGroup, UrlSegment, UrlSegmentGroup, UrlTree} from './url_tree';
import {forEach, last, shallowEqual} from './utils/collection';

const NG_DEV_MODE = typeof ngDevMode === 'undefined' || ngDevMode;

/**
 * Creates a `UrlTree` relative to an `ActivatedRouteSnapshot`.
 *
 * @publicApi
 *
 *
 * @param relativeTo The `ActivatedRouteSnapshot` to apply the commands to
 * @param commands An array of URL fragments with which to construct the new URL tree.
 * If the path is static, can be the literal URL string. For a dynamic path, pass an array of path
 * segments, followed by the parameters for each segment.
 * The fragments are applied to the one provided in the `relativeTo` parameter.
 * @param queryParams The query parameters for the `UrlTree`. `null` if the `UrlTree` does not have
 *     any query parameters.
 * @param fragment The fragment for the `UrlTree`. `null` if the `UrlTree` does not have a fragment.
 *
 * @usageNotes
 *
 * ```
 * // create /team/33/user/11
 * createUrlTreeFromSnapshot(snapshot, ['/team', 33, 'user', 11]);
 *
 * // create /team/33;expand=true/user/11
 * createUrlTreeFromSnapshot(snapshot, ['/team', 33, {expand: true}, 'user', 11]);
 *
 * // you can collapse static segments like this (this works only with the first passed-in value):
 * createUrlTreeFromSnapshot(snapshot, ['/team/33/user', userId]);
 *
 * // If the first segment can contain slashes, and you do not want the router to split it,
 * // you can do the following:
 * createUrlTreeFromSnapshot(snapshot, [{segmentPath: '/one/two'}]);
 *
 * // create /team/33/(user/11//right:chat)
 * createUrlTreeFromSnapshot(snapshot, ['/team', 33, {outlets: {primary: 'user/11', right:
 * 'chat'}}], null, null);
 *
 * // remove the right secondary node
 * createUrlTreeFromSnapshot(snapshot, ['/team', 33, {outlets: {primary: 'user/11', right: null}}]);
 *
 * // For the examples below, assume the current URL is for the `/team/33/user/11` and the
 * `ActivatedRouteSnapshot` points to `user/11`:
 *
 * // navigate to /team/33/user/11/details
 * createUrlTreeFromSnapshot(snapshot, ['details']);
 *
 * // navigate to /team/33/user/22
 * createUrlTreeFromSnapshot(snapshot, ['../22']);
 *
 * // navigate to /team/44/user/22
 * createUrlTreeFromSnapshot(snapshot, ['../../team/44/user/22']);
 * ```
 */
export function createUrlTreeFromSnapshot(
    relativeTo: ActivatedRouteSnapshot, commands: any[], queryParams: Params|null = null,
    fragment: string|null = null): UrlTree {
  const relativeToUrlSegmentGroup = createSegmentGroupFromRoute(relativeTo);
  return createUrlTreeFromSegmentGroup(relativeToUrlSegmentGroup, commands, queryParams, fragment);
}

function createSegmentGroupFromRoute(route: ActivatedRouteSnapshot): UrlSegmentGroup {
  let targetGroup: UrlSegmentGroup|undefined;

  function createSegmentGroupFromRouteRecursive(currentRoute: ActivatedRouteSnapshot) {
    const childOutlets: {[outlet: string]: UrlSegmentGroup} = {};
    for (const childSnapshot of currentRoute.children) {
      const root = createSegmentGroupFromRouteRecursive(childSnapshot);
      childOutlets[childSnapshot.outlet] = root;
    }
    const segmentGroup = new UrlSegmentGroup(currentRoute.url, childOutlets);
    if (currentRoute === route) {
      targetGroup = segmentGroup;
    }
    return segmentGroup;
  }
  const rootCandidate = createSegmentGroupFromRouteRecursive(route.root);
  const rootSegmentGroup = createRoot(rootCandidate);

  return targetGroup ?? rootSegmentGroup;
}

export function createUrlTreeFromSegmentGroup(
    relativeTo: UrlSegmentGroup, commands: any[], queryParams: Params|null,
    fragment: string|null): UrlTree {
  let root = relativeTo;
  while (root.parent) {
    root = root.parent;
  }
  // There are no commands so the `UrlTree` goes to the same path as the one created from the
  // `UrlSegmentGroup`. All we need to do is update the `queryParams` and `fragment` without
  // applying any other logic.
  if (commands.length === 0) {
    return tree(root, root, root, queryParams, fragment);
  }

  const nav = computeNavigation(commands);

  if (nav.toRoot()) {
    return tree(root, root, new UrlSegmentGroup([], {}), queryParams, fragment);
  }

  const position = findStartingPositionForTargetGroup(nav, root, relativeTo);
  const newSegmentGroup = position.processChildren ?
      updateSegmentGroupChildren(position.segmentGroup, position.index, nav.commands) :
      updateSegmentGroup(position.segmentGroup, position.index, nav.commands);
  return tree(root, position.segmentGroup, newSegmentGroup, queryParams, fragment);
}

export function createUrlTree(
    route: ActivatedRoute, urlTree: UrlTree, commands: any[], queryParams: Params|null,
    fragment: string|null): UrlTree {
  if (commands.length === 0) {
    return tree(urlTree.root, urlTree.root, urlTree.root, queryParams, fragment);
  }

  const nav = computeNavigation(commands);

  if (nav.toRoot()) {
    return tree(urlTree.root, urlTree.root, new UrlSegmentGroup([], {}), queryParams, fragment);
  }

  function createTreeUsingPathIndex(lastPathIndex: number) {
    const startingPosition =
        findStartingPosition(nav, urlTree, route.snapshot?._urlSegment, lastPathIndex);

    const segmentGroup = startingPosition.processChildren ?
        updateSegmentGroupChildren(
            startingPosition.segmentGroup, startingPosition.index, nav.commands) :
        updateSegmentGroup(startingPosition.segmentGroup, startingPosition.index, nav.commands);
    return tree(urlTree.root, startingPosition.segmentGroup, segmentGroup, queryParams, fragment);
  }
  // Note: The types should disallow `snapshot` from being `undefined` but due to test mocks, this
  // may be the case. Since we try to access it at an earlier point before the refactor to add the
  // warning for `relativeLinkResolution: 'legacy'`, this may cause failures in tests where it
  // didn't before.
  const result = createTreeUsingPathIndex(route.snapshot?._lastPathIndex);

  return result;
}

function isMatrixParams(command: any): boolean {
  return typeof command === 'object' && command != null && !command.outlets && !command.segmentPath;
}

/**
 * Determines if a given command has an `outlets` map. When we encounter a command
 * with an outlets k/v map, we need to apply each outlet individually to the existing segment.
 */
function isCommandWithOutlets(command: any): command is {outlets: {[key: string]: any}} {
  return typeof command === 'object' && command != null && command.outlets;
}

function tree(
    oldRoot: UrlSegmentGroup, oldSegmentGroup: UrlSegmentGroup, newSegmentGroup: UrlSegmentGroup,
    queryParams: Params|null, fragment: string|null): UrlTree {
  let qp: any = {};
  if (queryParams) {
    forEach(queryParams, (value: any, name: any) => {
      qp[name] = Array.isArray(value) ? value.map((v: any) => `${v}`) : `${value}`;
    });
  }

  let rootCandidate: UrlSegmentGroup;
  if (oldRoot === oldSegmentGroup) {
    rootCandidate = newSegmentGroup;
  } else {
    rootCandidate = replaceSegment(oldRoot, oldSegmentGroup, newSegmentGroup);
  }

  const newRoot = createRoot(squashSegmentGroup(rootCandidate));
  return new UrlTree(newRoot, qp, fragment);
}

/**
 * Replaces the `oldSegment` which is located in some child of the `current` with the `newSegment`.
 * This also has the effect of creating new `UrlSegmentGroup` copies to update references. This
 * shouldn't be necessary but the fallback logic for an invalid ActivatedRoute in the creation uses
 * the Router's current url tree. If we don't create new segment groups, we end up modifying that
 * value.
 */
function replaceSegment(
    current: UrlSegmentGroup, oldSegment: UrlSegmentGroup,
    newSegment: UrlSegmentGroup): UrlSegmentGroup {
  const children: {[key: string]: UrlSegmentGroup} = {};
  forEach(current.children, (c: UrlSegmentGroup, outletName: string) => {
    if (c === oldSegment) {
      children[outletName] = newSegment;
    } else {
      children[outletName] = replaceSegment(c, oldSegment, newSegment);
    }
  });
  return new UrlSegmentGroup(current.segments, children);
}

class Navigation {
  constructor(
      public isAbsolute: boolean, public numberOfDoubleDots: number, public commands: any[]) {
    if (isAbsolute && commands.length > 0 && isMatrixParams(commands[0])) {
      throw new RuntimeError(
          RuntimeErrorCode.ROOT_SEGMENT_MATRIX_PARAMS,
          NG_DEV_MODE && 'Root segment cannot have matrix parameters');
    }

    const cmdWithOutlet = commands.find(isCommandWithOutlets);
    if (cmdWithOutlet && cmdWithOutlet !== last(commands)) {
      throw new RuntimeError(
          RuntimeErrorCode.MISPLACED_OUTLETS_COMMAND,
          NG_DEV_MODE && '{outlets:{}} has to be the last command');
    }
  }

  public toRoot(): boolean {
    return this.isAbsolute && this.commands.length === 1 && this.commands[0] == '/';
  }
}

/** Transforms commands to a normalized `Navigation` */
function computeNavigation(commands: any[]): Navigation {
  if ((typeof commands[0] === 'string') && commands.length === 1 && commands[0] === '/') {
    return new Navigation(true, 0, commands);
  }

  let numberOfDoubleDots = 0;
  let isAbsolute = false;

  const res: any[] = commands.reduce((res, cmd, cmdIdx) => {
    if (typeof cmd === 'object' && cmd != null) {
      if (cmd.outlets) {
        const outlets: {[k: string]: any} = {};
        forEach(cmd.outlets, (commands: any, name: string) => {
          outlets[name] = typeof commands === 'string' ? commands.split('/') : commands;
        });
        return [...res, {outlets}];
      }

      if (cmd.segmentPath) {
        return [...res, cmd.segmentPath];
      }
    }

    if (!(typeof cmd === 'string')) {
      return [...res, cmd];
    }

    if (cmdIdx === 0) {
      cmd.split('/').forEach((urlPart, partIndex) => {
        if (partIndex == 0 && urlPart === '.') {
          // skip './a'
        } else if (partIndex == 0 && urlPart === '') {  //  '/a'
          isAbsolute = true;
        } else if (urlPart === '..') {  //  '../a'
          numberOfDoubleDots++;
        } else if (urlPart != '') {
          res.push(urlPart);
        }
      });

      return res;
    }

    return [...res, cmd];
  }, []);

  return new Navigation(isAbsolute, numberOfDoubleDots, res);
}

class Position {
  constructor(
      public segmentGroup: UrlSegmentGroup, public processChildren: boolean, public index: number) {
  }
}

function findStartingPositionForTargetGroup(
    nav: Navigation, root: UrlSegmentGroup, target: UrlSegmentGroup): Position {
  if (nav.isAbsolute) {
    return new Position(root, true, 0);
  }

  if (!target) {
    // `NaN` is used only to maintain backwards compatibility with incorrectly mocked
    // `ActivatedRouteSnapshot` in tests. In prior versions of this code, the position here was
    // determined based on an internal property that was rarely mocked, resulting in `NaN`. In
    // reality, this code path should _never_ be touched since `target` is not allowed to be falsey.
    return new Position(root, false, NaN);
  }
  if (target.parent === null) {
    return new Position(target, true, 0);
  }

  const modifier = isMatrixParams(nav.commands[0]) ? 0 : 1;
  const index = target.segments.length - 1 + modifier;
  return createPositionApplyingDoubleDots(target, index, nav.numberOfDoubleDots);
}

function findStartingPosition(
    nav: Navigation, tree: UrlTree, segmentGroup: UrlSegmentGroup,
    lastPathIndex: number): Position {
  if (nav.isAbsolute) {
    return new Position(tree.root, true, 0);
  }

  if (lastPathIndex === -1) {
    // Pathless ActivatedRoute has _lastPathIndex === -1 but should not process children
    // see issue #26224, #13011, #35687
    // However, if the ActivatedRoute is the root we should process children like above.
    const processChildren = segmentGroup === tree.root;
    return new Position(segmentGroup, processChildren, 0);
  }

  const modifier = isMatrixParams(nav.commands[0]) ? 0 : 1;
  const index = lastPathIndex + modifier;
  return createPositionApplyingDoubleDots(segmentGroup, index, nav.numberOfDoubleDots);
}

function createPositionApplyingDoubleDots(
    group: UrlSegmentGroup, index: number, numberOfDoubleDots: number): Position {
  let g = group;
  let ci = index;
  let dd = numberOfDoubleDots;
  while (dd > ci) {
    dd -= ci;
    g = g.parent!;
    if (!g) {
      throw new RuntimeError(
          RuntimeErrorCode.INVALID_DOUBLE_DOTS, NG_DEV_MODE && 'Invalid number of \'../\'');
    }
    ci = g.segments.length;
  }
  return new Position(g, false, ci - dd);
}

function getOutlets(commands: unknown[]): {[k: string]: unknown[]|string} {
  if (isCommandWithOutlets(commands[0])) {
    return commands[0].outlets;
  }

  return {[PRIMARY_OUTLET]: commands};
}

function updateSegmentGroup(
    segmentGroup: UrlSegmentGroup, startIndex: number, commands: any[]): UrlSegmentGroup {
  if (!segmentGroup) {
    segmentGroup = new UrlSegmentGroup([], {});
  }
  if (segmentGroup.segments.length === 0 && segmentGroup.hasChildren()) {
    return updateSegmentGroupChildren(segmentGroup, startIndex, commands);
  }

  const m = prefixedWith(segmentGroup, startIndex, commands);
  const slicedCommands = commands.slice(m.commandIndex);
  if (m.match && m.pathIndex < segmentGroup.segments.length) {
    const g = new UrlSegmentGroup(segmentGroup.segments.slice(0, m.pathIndex), {});
    g.children[PRIMARY_OUTLET] =
        new UrlSegmentGroup(segmentGroup.segments.slice(m.pathIndex), segmentGroup.children);
    return updateSegmentGroupChildren(g, 0, slicedCommands);
  } else if (m.match && slicedCommands.length === 0) {
    return new UrlSegmentGroup(segmentGroup.segments, {});
  } else if (m.match && !segmentGroup.hasChildren()) {
    return createNewSegmentGroup(segmentGroup, startIndex, commands);
  } else if (m.match) {
    return updateSegmentGroupChildren(segmentGroup, 0, slicedCommands);
  } else {
    return createNewSegmentGroup(segmentGroup, startIndex, commands);
  }
}

function updateSegmentGroupChildren(
    segmentGroup: UrlSegmentGroup, startIndex: number, commands: any[]): UrlSegmentGroup {
  if (commands.length === 0) {
    return new UrlSegmentGroup(segmentGroup.segments, {});
  } else {
    const outlets = getOutlets(commands);
    const children: {[key: string]: UrlSegmentGroup} = {};

    forEach(outlets, (commands, outlet) => {
      if (typeof commands === 'string') {
        commands = [commands];
      }
      if (commands !== null) {
        children[outlet] = updateSegmentGroup(segmentGroup.children[outlet], startIndex, commands);
      }
    });

    forEach(segmentGroup.children, (child: UrlSegmentGroup, childOutlet: string) => {
      if (outlets[childOutlet] === undefined) {
        children[childOutlet] = child;
      }
    });
    return new UrlSegmentGroup(segmentGroup.segments, children);
  }
}

function prefixedWith(segmentGroup: UrlSegmentGroup, startIndex: number, commands: any[]) {
  let currentCommandIndex = 0;
  let currentPathIndex = startIndex;

  const noMatch = {match: false, pathIndex: 0, commandIndex: 0};
  while (currentPathIndex < segmentGroup.segments.length) {
    if (currentCommandIndex >= commands.length) return noMatch;
    const path = segmentGroup.segments[currentPathIndex];
    const command = commands[currentCommandIndex];
    // Do not try to consume command as part of the prefixing if it has outlets because it can
    // contain outlets other than the one being processed. Consuming the outlets command would
    // result in other outlets being ignored.
    if (isCommandWithOutlets(command)) {
      break;
    }
    const curr = `${command}`;
    const next =
        currentCommandIndex < commands.length - 1 ? commands[currentCommandIndex + 1] : null;

    if (currentPathIndex > 0 && curr === undefined) break;

    if (curr && next && (typeof next === 'object') && next.outlets === undefined) {
      if (!compare(curr, next, path)) return noMatch;
      currentCommandIndex += 2;
    } else {
      if (!compare(curr, {}, path)) return noMatch;
      currentCommandIndex++;
    }
    currentPathIndex++;
  }

  return {match: true, pathIndex: currentPathIndex, commandIndex: currentCommandIndex};
}

function createNewSegmentGroup(
    segmentGroup: UrlSegmentGroup, startIndex: number, commands: any[]): UrlSegmentGroup {
  const paths = segmentGroup.segments.slice(0, startIndex);

  let i = 0;
  while (i < commands.length) {
    const command = commands[i];
    if (isCommandWithOutlets(command)) {
      const children = createNewSegmentChildren(command.outlets);
      return new UrlSegmentGroup(paths, children);
    }

    // if we start with an object literal, we need to reuse the path part from the segment
    if (i === 0 && isMatrixParams(commands[0])) {
      const p = segmentGroup.segments[startIndex];
      paths.push(new UrlSegment(p.path, stringify(commands[0])));
      i++;
      continue;
    }

    const curr = isCommandWithOutlets(command) ? command.outlets[PRIMARY_OUTLET] : `${command}`;
    const next = (i < commands.length - 1) ? commands[i + 1] : null;
    if (curr && next && isMatrixParams(next)) {
      paths.push(new UrlSegment(curr, stringify(next)));
      i += 2;
    } else {
      paths.push(new UrlSegment(curr, {}));
      i++;
    }
  }
  return new UrlSegmentGroup(paths, {});
}

function createNewSegmentChildren(outlets: {[name: string]: unknown[]|string}):
    {[outlet: string]: UrlSegmentGroup} {
  const children: {[outlet: string]: UrlSegmentGroup} = {};
  forEach(outlets, (commands, outlet) => {
    if (typeof commands === 'string') {
      commands = [commands];
    }
    if (commands !== null) {
      children[outlet] = createNewSegmentGroup(new UrlSegmentGroup([], {}), 0, commands);
    }
  });
  return children;
}

function stringify(params: {[key: string]: any}): {[key: string]: string} {
  const res: {[key: string]: string} = {};
  forEach(params, (v: any, k: string) => res[k] = `${v}`);
  return res;
}

function compare(path: string, params: {[key: string]: any}, segment: UrlSegment): boolean {
  return path == segment.path && shallowEqual(params, segment.parameters);
}
