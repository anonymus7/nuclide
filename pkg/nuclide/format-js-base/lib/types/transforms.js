'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

/**
 * These are all of the transforms that may be run via `transform`.
 */
export type TransformKey =
  'requires.removeUnusedRequires' |
  'requires.addMissingRequires' |
  'requires.removeUnusedTypes' |
  'requires.addMissingTypes' |
  'requires.formatRequires';
