// Angular builds every test entry before running it. Keep worker memory bounded
// when the suite imports Monaco and other substantial browser libraries.
export default {
  test: { maxWorkers: 4, isolate: true },
};
