package main

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/db"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "uso: nexo-db bootstrap [--init-app-role] | baseline | up | verificar")
		os.Exit(2)
	}
	root, err := db.Root()
	if err == nil {
		err = db.Admin(context.Background(), os.Args[1], root, len(os.Args) > 2 && os.Args[2] == "--init-app-role")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(os.Args[1] + ": ok")
}
