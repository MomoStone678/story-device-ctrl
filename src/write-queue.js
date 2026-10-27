/** 串行写队列：关包与开包/保活互不插队盖掉。 */

export class WriteQueue {
  constructor() {
    this._chain = Promise.resolve();
  }

  enqueue(task) {
    const run = this._chain.then(task, task);
    this._chain = run.catch(() => {});
    return run;
  }

  /** 等当前队列排空（开之前先等停完） */
  async drain() {
    await this.enqueue(async () => {});
  }
}
