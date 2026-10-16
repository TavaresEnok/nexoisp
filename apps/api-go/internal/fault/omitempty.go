//go:build mutacao_omitempty

package fault

func Active(name string) bool { return name == "omitempty" }
