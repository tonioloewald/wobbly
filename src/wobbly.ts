/**
 * A generic type for functions that can be executed in a Web Worker.
 * The function must be serializable.
 */
type WorkerOperation<T, U> = (data: T[], fn: (item: T) => U, workerIndex: number) => U[] | U | void;

const workerScript = `
  self.onmessage = (event) => {
    const { type, data, fn, workerIndex, context } = event.data;
    const contextObj = JSON.parse(context);
    const operationFn = (new Function('return ' + fn)()).bind(contextObj);
    
    try {
      let result;
      const total = data.length;
      let processed = 0;
      const reportInterval = Math.max(1, Math.floor(total / 10)); // Report progress at least 10 times

      const processItem = (item) => {
        processed++;
        if (processed % reportInterval === 0 || processed === total) {
          const progress = processed / total;
          self.postMessage({ type: 'progress', workerIndex, progress });
        }
        return operationFn(item);
      };

      switch (type) {
        case 'map':
          result = data.map(processItem);
          break;
        case 'filter':
          result = data.filter(processItem);
          break;
        case 'reduce':
          // Fix for double-counting: correctly use the first element as the accumulator
          result = data.reduce(operationFn, undefined);
          break;
        case 'forEach':
          data.forEach(processItem);
          break;
        default:
          console.error('Unknown operation type:', type);
          return;
      }
      self.postMessage({ type: 'result', result, workerIndex });
    } catch (e) {
      console.error('Error in worker:', e);
      self.postMessage({ type: 'result', result: null, workerIndex });
    }
  };
`;

const workerBlob = new Blob([workerScript], { type: 'application/javascript' });
const WORKER_URL = URL.createObjectURL(workerBlob);

/**
 * A type to represent the message sent from the main thread to the worker.
 */
interface WorkerMessage<T, U> {
  type: 'map' | 'forEach' | 'filter' | 'reduce';
  data: T[];
  fn: string; // The function to be executed, serialized as a string
  workerIndex: number;
}

/**
 * A type for the message received from the worker.
 */
interface WorkerResult<U> {
  type: 'result' | 'progress';
  result?: U[] | U | void;
  workerIndex: number;
  progress?: number;
}

/**
 * The core class for managing Web Workers and performing asynchronous array operations.
 * It creates a pool of workers and distributes tasks among them.
 */
export class AsyncArray<T> {
  private readonly maxWorkers: number;
  private workerUrl: string | null = null;
  private progressReportInterval: number;

  constructor(maxWorkers: number = navigator.hardwareConcurrency || 4, progressReportInterval: number = 100) {
    this.maxWorkers = maxWorkers;
    this.progressReportInterval = progressReportInterval;
  }
  
  private serializedContext: string = '{}'
  
  public withContext(context: any): AsyncArray<T> {
    this.serializedContext = JSON.stringify(context)
    return this
  }

  /**
   * Initializes a pool of Web Workers.
   */
  private initializeWorkers(): Worker[] {
    const workers: Worker[] = [];
    

    for (let i = 0; i < this.maxWorkers; i++) {
      workers.push(new Worker(WORKER_URL));
    }
    
    return workers
  }

  /**
   * Dispatches a task to the Web Worker pool.
   * @param type The type of array operation.
   * @param array The array to process.
   * @param fn The function to apply to each element.
   * @param progressCallback An optional callback to report progress.
   * @returns A Promise that resolves with the result.
   */
  private dispatch<U>(
    type: 'map' | 'forEach' | 'filter' | 'reduce',
    array: T[],
    fn: (this: any, item: T, ...args: any[]) => any,
    progressCallback?: (progress: number) => void
  ): Promise<U[] | U | void> {
    const workers = this.initializeWorkers()
    return new Promise((resolve, reject) => {
      if (array.length === 0) {
        if (progressCallback) progressCallback(1);
        resolve(type === 'map' || type === 'filter' ? [] : undefined);
        return;
      }
      
      const cleanup = (e?: Error) => {
        workers.forEach(worker => worker.terminate());
        if (e) reject(e); // Reject the promise on error
      };

      const chunkSize = Math.ceil(array.length / this.maxWorkers);
      let results: (U[] | U | void)[] = new Array(this.maxWorkers);
      let receivedCount = 0;
      let lastReportedProgress = 0;
      let workerProgress: number[] = new Array(this.maxWorkers).fill(0);

      const onMessage = (event: MessageEvent<WorkerResult<U>>) => {
        const { type: messageType, result, workerIndex, progress } = event.data;
        
        if (messageType === 'progress' && progressCallback) {
          workerProgress[workerIndex] = progress || 0;
          const totalProgress = workerProgress.reduce((sum, p) => sum + p, 0) / this.maxWorkers;
          if (totalProgress - lastReportedProgress >= 0.01 || totalProgress === 1) {
            progressCallback(totalProgress);
            lastReportedProgress = totalProgress;
          }
        } else if (messageType === 'result') {
          results[workerIndex] = result;
          receivedCount++;

          if (receivedCount === this.maxWorkers) {
            cleanup();

            // Combine results based on operation type
            if (type === 'map' || type === 'filter') {
              resolve((results as U[][]).flat());
            } else if (type === 'reduce') {
              // Re-reduce the results from each worker
              const context = Object.assign(JSON.parse(this.serializedContext), {final: true})
              const reducer = fn.bind(context)
              const finalResult = (results as U[]).reduce(reducer as any, undefined);
              resolve(finalResult);
            } else {
              resolve();
            }
          }
        }
      };

      workers.forEach((worker, index) => {
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', (e) => {
          cleanup(new Error(`Worker ${index} error: ${e.message}`))
        })
        const chunk = array.slice(index * chunkSize, (index + 1) * chunkSize);
        
        const message: WorkerMessage<T, U> = {
          type,
          data: chunk,
          fn: fn.toString(), // Serialize the function to a string
          workerIndex: index,
          context: this.serializedContext
        };
        worker.postMessage(message);
      });
    });
  }

  /**
   * Asynchronously maps an array using Web Workers.
   * @param array The array to map.
   * @param fn The mapping function.
   * @param progressCallback An optional callback to report progress.
   * @returns A Promise that resolves with the new mapped array.
   */
  public async map<U>(array: T[], fn: (item: T) => U, progressCallback?: (progress: number) => void): Promise<U[]> {
    const result = await this.dispatch<U>('map', array, fn, progressCallback);
    return result as U[];
  }

  /**
   * Asynchronously filters an array using Web Workers.
   * @param array The array to filter.
   * @param fn The filtering function.
   * @param progressCallback An optional callback to report progress.
   * @returns A Promise that resolves with the new filtered array.
   */
  public async filter(array: T[], fn: (item: T) => boolean, progressCallback?: (progress: number) => void): Promise<T[]> {
    const result = await this.dispatch<T>('filter', array, fn, progressCallback);
    return result as T[];
  }

  /**
   * Asynchronously iterates over an array using Web Workers.
   * @param array The array to iterate over.
   * @param fn The function to execute for each item.
   * @param progressCallback An optional callback to report progress.
   * @returns A Promise that resolves when the operation is complete.
   */
  public async forEach(array: T[], fn: (item: T) => void, progressCallback?: (progress: number) => void): Promise<void> {
    await this.dispatch<void>('forEach', array, fn, progressCallback);
  }

  /**
   * Asynchronously reduces an array using Web Workers.
   * @param array The array to reduce.
   * @param fn The reducing function.
   * @param progressCallback An optional callback to report progress.
   * @returns A Promise that resolves with the final reduced value.
   */
  public async reduce<U>(array: T[], fn: (accumulator: U, item: T) => U, progressCallback?: (progress: number) => void): Promise<U> {
    const result = await this.dispatch<U>('reduce', array, fn, progressCallback);
    return result as U;
  }
}
