import { Observable } from "../Observable";

function toArrayPromise<T>(observable: Observable<T>): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const values: T[] = [];
    observable.subscribe({
      next(value) {
        values.push(value);
      },
      error: reject,
      complete() {
        resolve(values);
      },
    });
  });
}

describe("Observable subclassing", () => {
  it("Symbol.species is defined for Observable subclass", async () => {
    const observable = Observable.of(1, 2, 3);
    expect(observable).toBeInstanceOf(Observable);

    const mapped = observable.map((n) => n * 2);
    expect(mapped).toBeInstanceOf(Observable);

    const doubles = await toArrayPromise(mapped);
    expect(doubles).toEqual([2, 4, 6]);
  });

  it("Observable.of static method returns an Observable", async () => {
    const observable = Observable.of("asdf", "qwer", "zxcv");
    expect(observable).toBeInstanceOf(Observable);

    const values = await toArrayPromise(observable);
    expect(values).toEqual(["asdf", "qwer", "zxcv"]);
  });

  it("Observable.concat chains observables", async () => {
    const first = Observable.of(1, 2);
    const second = Observable.of(3, 4);
    const concatenated = first.concat(second);

    const values = await toArrayPromise(concatenated);
    expect(values).toEqual([1, 2, 3, 4]);
  });
});
