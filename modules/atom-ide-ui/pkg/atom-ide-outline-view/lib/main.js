/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

import type {Result} from 'nuclide-commons-atom/ActiveEditorRegistry';
import type {
  WorkspaceViewsService,
} from 'nuclide-commons-atom/workspace-views-compat';

import ActiveEditorRegistry from 'nuclide-commons-atom/ActiveEditorRegistry';
import {observeActivePaneItemDebounced} from 'nuclide-commons-atom/debounced';
import {isValidTextEditor} from 'nuclide-commons-atom/text-editor';
import createPackage from 'nuclide-commons-atom/createPackage';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import analytics from 'nuclide-commons-atom/analytics';
import {
  consumeWorkspaceViewsCompat,
} from 'nuclide-commons-atom/workspace-views-compat';

import {OutlineViewPanelState, WORKSPACE_VIEW_URI} from './OutlineViewPanel';
import {createOutlines} from './createOutlines';
import {Observable} from 'rxjs';

import type {TokenizedText} from 'nuclide-commons/tokenized-text';
import type {Outline, OutlineTree, OutlineTreeKind} from './rpc-types';

export type {Outline, OutlineTree, OutlineTreeKind};

export type OutlineTreeForUi = {
  icon?: string, // from atom$Octicon, but we use string for convenience of remoting
  kind?: OutlineTreeKind, // kind you can pass to the UI for theming
  plainText?: string,
  tokenizedText?: TokenizedText,

  startPosition: atom$Point,
  endPosition?: atom$Point,
  children: Array<OutlineTreeForUi>,
  highlighted: boolean,
};

/**
 * Includes additional information that is useful to the UI, but redundant or nonsensical for
 * providers to include in their responses.
 */
export type OutlineForUi =
  | {
      // The initial state at startup.
      kind: 'empty',
    }
  | {
      // The thing that currently has focus is not a text editor.
      kind: 'not-text-editor',
    }
  | {
      // Currently awaiting results from a provider (for longer than a certain delay).
      kind: 'loading',
    }
  | {
      // Indicates that no provider is registered for the given grammar.
      kind: 'no-provider',
      // Human-readable name for the grammar.
      grammar: string,
    }
  | {
      // Indicates that a provider is registered but that it did not return an outline.
      kind: 'provider-no-outline',
    }
  | {
      kind: 'outline',
      outlineTrees: Array<OutlineTreeForUi>,
      /**
   * Use a TextEditor instead of a path so that:
   * - If there are multiple editors for a file, we always jump to outline item
   *   locations in the correct editor.
   * - Jumping to outline item locations works for new, unsaved files.
   */
      editor: atom$TextEditor,
    };

export type OutlineProvider = {
  name: string,
  // If there are multiple providers for a given grammar, the one with the highest priority will be
  // used.
  priority: number,
  grammarScopes: Array<string>,
  updateOnEdit?: boolean,
  getOutline(editor: TextEditor): Promise<?Outline>,
};

export type SerializedOutlineViewPanelState = {
  deserializer: 'atom-ide-ui.OutlineViewPanelState',
};

export type ResultsStreamProvider = {
  getResultsStream: () => Observable<Result<OutlineProvider, ?Outline>>,
};

class Activation {
  _disposables: UniversalDisposable;

  _editorService: ActiveEditorRegistry<OutlineProvider, ?Outline>;

  constructor() {
    this._disposables = new UniversalDisposable();
    this._disposables.add(
      consumeWorkspaceViewsCompat(service =>
        this.consumeWorkspaceViewsService(service),
      ),
    );

    this._editorService = new ActiveEditorRegistry(
      (provider, editor) => {
        analytics.track('nuclide-outline-view-getoutline');
        return provider.getOutline(editor);
      },
      {},
      getActiveEditorRegistryEventSources(),
    );
  }

  dispose() {
    this._disposables.dispose();
  }

  consumeOutlineProvider(provider: OutlineProvider): IDisposable {
    return this._editorService.consumeProvider(provider);
  }

  consumeToolBar(getToolBar: toolbar$GetToolbar): IDisposable {
    const toolBar = getToolBar('nuclide-outline-view');
    const {element} = toolBar.addButton({
      icon: 'list-unordered',
      callback: 'nuclide-outline-view:toggle',
      tooltip: 'Toggle Outline View',
      priority: 200,
    });
    // Class added is not defined elsewhere, and is just used to mark the toolbar button
    element.classList.add('nuclide-outline-view-toolbar-button');
    const disposable = new UniversalDisposable(() => {
      toolBar.removeItems();
    });
    this._disposables.add(disposable);
    return disposable;
  }

  _createOutlineViewPanelState(): OutlineViewPanelState {
    analytics.track('nuclide-outline-view-show');
    return new OutlineViewPanelState(createOutlines(this._editorService));
  }

  consumeWorkspaceViewsService(api: WorkspaceViewsService): IDisposable {
    const commandDisposable = atom.commands.add(
      'atom-workspace',
      'outline-view:toggle',
      event => {
        api.toggle(WORKSPACE_VIEW_URI, (event: any).detail);
      },
    );
    this._disposables.add(
      api.addOpener(uri => {
        if (uri === WORKSPACE_VIEW_URI) {
          return this._createOutlineViewPanelState();
        }
      }),
      () => api.destroyWhere(item => item instanceof OutlineViewPanelState),
      commandDisposable,
    );
    return commandDisposable;
  }

  deserializeOutlineViewPanelState(): OutlineViewPanelState {
    return this._createOutlineViewPanelState();
  }

  getOutlineViewResultsStream(): ResultsStreamProvider {
    return {
      getResultsStream: () => this._editorService.getResultsStream(),
    };
  }
}

createPackage(module.exports, Activation);

// TODO this can be removed once we no longer want to support versions of Atom less than 1.17.0
// (D4973408)
function getActiveEditorRegistryEventSources() {
  return {
    activeEditors: observeActivePaneItemDebounced()
      .switchMap(item => {
        if (isValidTextEditor(item)) {
          // Flow cannot understand the type refinement provided by the isValidTextEditor function,
          // so we have to cast.
          return Observable.of(((item: any): atom$TextEditor));
        } else if (item instanceof OutlineViewPanelState) {
          // Ignore switching to the outline view.
          return Observable.empty();
        }
        return Observable.of(null);
      })
      .distinctUntilChanged(),
  };
}
