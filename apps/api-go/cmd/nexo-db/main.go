package main

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/db"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "uso: nexo-db bootstrap [--init-app-role] | baseline | up | jobs-up | verificar")
		os.Exit(2)
	}
	if os.Args[1] == "jobs-up" {
		if err := db.JobsMigrate(context.Background(), os.Getenv("DATABASE_URL_OWNER")); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("jobs-up: ok")
		return
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
