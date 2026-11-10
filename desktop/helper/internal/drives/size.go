package drives

import (
	"fmt"
	"os"
)

// deviceSize is a regular file's size or a block device's capacity.
func deviceSize(path string) (int64, error) {
	st, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	if st.Mode().IsRegular() {
		return st.Size(), nil
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return FileSize(f)
}

// FileSize is the capacity behind an open file: a regular file's size or a
// block device's size (seek to end works for block devices on Linux and
// macOS; Windows physical drives are sized by enumeration instead).
func FileSize(f *os.File) (int64, error) {
	st, err := f.Stat()
	if err != nil {
		return 0, err
	}
	if st.Mode().IsRegular() {
		return st.Size(), nil
	}
	end, err := f.Seek(0, 2)
	if err != nil {
		return 0, fmt.Errorf("size of %s: %w", f.Name(), err)
	}
	if _, err := f.Seek(0, 0); err != nil {
		return 0, err
	}
	return end, nil
}
