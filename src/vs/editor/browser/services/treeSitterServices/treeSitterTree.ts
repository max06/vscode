/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { runWhenIdle } from 'vs/base/common/async';
import { ITextModel } from 'vs/editor/common/model';
import { createTextModel } from 'vs/editor/test/common/testTextModel';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import Parser = require('web-tree-sitter');
import { IModelContentChangedEvent } from 'vs/editor/common/textModelEvents';
import { DisposableStore } from 'vs/base/common/lifecycle';

export class TreeSitterTree {

	private readonly _parser: Parser;
	private _tree: Parser.Tree | undefined;
	private _edits: Parser.Edit[];
	private _nCallsParseTree: number;
	private readonly _store: DisposableStore = new DisposableStore();

	constructor(
		private readonly _model: ITextModel,
		_language: Parser.Language
	) {
		this._parser = new Parser();
		this._parser.setLanguage(_language);
		this._edits = [];
		this._nCallsParseTree = 0;
		this.parseTree().then((tree) => {
			if (tree) {
				this._tree = tree;
			}
		})
		this._store.add(this._model.onDidChangeContent((contentChangeEvent: IModelContentChangedEvent) => {
			this.registerTreeEdits(contentChangeEvent);
		}));
	}

	public registerTreeEdits(contentChangeEvent: IModelContentChangedEvent): void {
		for (const change of contentChangeEvent.changes) {
			const newEndPositionFromModel = this._model.getPositionAt(change.rangeOffset + change.text.length);
			this._edits.push({
				startPosition: { row: change.range.startLineNumber - 1, column: change.range.startColumn - 1 },
				oldEndPosition: { row: change.range.endLineNumber - 1, column: change.range.endColumn - 1 },
				newEndPosition: { row: newEndPositionFromModel.lineNumber - 1, column: newEndPositionFromModel.column - 1 },
				startIndex: change.rangeOffset,
				oldEndIndex: change.rangeOffset + change.rangeLength,
				newEndIndex: change.rangeOffset + change.text.length
			} as Parser.Edit);
		}
	}

	public async parseTree(asynchronous: boolean = true): Promise<Parser.Tree> {
		this._nCallsParseTree = 0;
		return this._parseTree(asynchronous);
	}

	public async parseTreeAndCountCalls(asynchronous: boolean = true): Promise<number> {
		this._nCallsParseTree = 0;
		return this._parseTree(asynchronous).then(() => {
			return Promise.resolve(this._nCallsParseTree);
		})
	}

	private _currentParseOperation: Promise<Parser.Tree> | undefined;

	private async _parseTree(asynchronous: boolean = true): Promise<Parser.Tree> {
		await this._currentParseOperation;
		// Case 1: Either there is no tree yet or there are edits to parse
		if (!this._tree || this._edits.length !== 0) {
			const myParseOperation = this._tryParseSync(asynchronous);
			this._currentParseOperation = myParseOperation;
			myParseOperation.then((tree) => {
				if (this._currentParseOperation === myParseOperation) {
					this._currentParseOperation = undefined;
				}
				if (this._edits.length !== 0) {
					return this._parseTree(asynchronous);
				}
				this._nCallsParseTree += 1;
				return tree;
			})
			this._nCallsParseTree += 1;
			return this._currentParseOperation;
		}
		// Case 2: Else
		else {
			this._nCallsParseTree += 1;
			return this._tree;
		}
	}

	private async _tryParseSync(asynchronous: boolean = true): Promise<Parser.Tree> {
		console.log('asynchronous : ', asynchronous);
		if (asynchronous) {
			this._parser.setTimeoutMicros(10000);
		}
		let tree = this.updateAndGetTree();
		// Initially synchronous
		try {
			console.log('calling _parseSync');
			let result = this._parser.parse(
				(startIndex: number, startPoint: Parser.Point | undefined, endIndex: number | undefined) =>
					this._retrieveTextAtPosition(this._model, startIndex, startPoint, endIndex),
				tree
			);
			this._tree = result;
			return result;
		}
		// Else if parsing failed, asynchronous
		catch (error) {
			console.log('calling _parseAsync');
			const textModel = createTextModel('');
			textModel.setValue(this._model.createSnapshot());
			return new Promise((resolve, _reject) => {
				this._parseAsync(textModel, tree).then((tree) => {
					this._tree = tree;
					resolve(tree);
				})
			})
		}
	}

	private updateAndGetTree(): Parser.Tree | undefined {
		if (!this._tree) {
			return undefined;
		}
		for (const edit of this._edits) {
			this._tree.edit(edit);
		}
		this._edits.length = 0;
		return this._tree;
	}

	private _parseAsync(textModel: ITextModel, tree: Parser.Tree | undefined): Promise<Parser.Tree> {
		return new Promise((resolve, _reject) => {
			runWhenIdle(
				async (arg) => {
					this._parser.setTimeoutMicros(arg.timeRemaining() * 1000);
					let result: Parser.Tree;
					try {
						result = this._parser.parse(
							(startIndex: number, startPoint: Parser.Point | undefined, endIndex: number | undefined) =>
								this._retrieveTextAtPosition(textModel, startIndex, startPoint, endIndex),
							tree
						);
						// Case 1: Either we obtain the result this iteration in which case we resolve
						this._tree = result;
						resolve(result);

					}
					// Case 3: Here in the catch block treat the case when the parse has failed, then rerun the method
					catch (error) {
						return this._parseAsync(textModel, tree).then((tree) => {
							resolve(tree);
						})
					}
				},
				1000
			);
		})
	}

	private _retrieveTextAtPosition(model: ITextModel, startIndex: number, _startPoint: Parser.Point | undefined, endIndex: number | undefined) {
		const startPosition: Position = model.getPositionAt(startIndex);
		let endPosition: Position;
		if (typeof endIndex !== 'number') {
			endIndex = startIndex + 5000;
		}
		endPosition = model.getPositionAt(endIndex);
		return model.getValueInRange(Range.fromPositions(startPosition, endPosition));
	}

	public dispose() {
		this._store.dispose();
		this._tree?.delete();
		this._parser.delete();
		this._edits.length = 0;
	}
}